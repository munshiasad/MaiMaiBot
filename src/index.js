require("dotenv").config();

const { Telegraf, Markup } = require("telegraf");
const { MCPClient } = require("./mcpClient");
const { TTLCache } = require("./cache");
const { getUser, getGlobalState, updateGlobalState, upsertUser, deleteUser, allUsers } = require("./storage");
const { getLocalDate, getMinutesSinceMidnight, getLocalDateTime } = require("./time");
const { createTelegraphPage } = require("./telegraph");

function readNumberEnv(key, fallback, options = {}) {
  const raw = process.env[key];
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.warn(`Invalid ${key}=${raw}, using default ${fallback}.`);
    return fallback;
  }
  let value = parsed;
  if (Number.isFinite(options.min) && value < options.min) {
    console.warn(`Clamping ${key}=${parsed} to min ${options.min}.`);
    value = options.min;
  }
  if (Number.isFinite(options.max) && value > options.max) {
    console.warn(`Clamping ${key}=${parsed} to max ${options.max}.`);
    value = options.max;
  }
  return value;
}

function readBooleanEnv(key, fallback = false) {
  const raw = process.env[key];
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  const normalized = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function normalizeHour(value, fallback) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  if (value === 24) {
    console.warn("AUTO_CLAIM_HOUR=24 treated as 0 (midnight).");
    return 0;
  }
  if (value < 0) {
    console.warn(`AUTO_CLAIM_HOUR ${value} < 0, clamping to 0.`);
    return 0;
  }
  if (value > 24) {
    const wrapped = value % 24;
    console.warn(`AUTO_CLAIM_HOUR ${value} > 24, wrapping to ${wrapped}.`);
    return wrapped;
  }
  return value;
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN in environment.");
  process.exit(1);
}

const MCP_URL = process.env.MCD_MCP_URL || "https://mcp.mcd.cn/mcp-servers/mcd-mcp";
const MCP_PROTOCOL_VERSION = process.env.MCP_PROTOCOL_VERSION || "2025-06-18";
const MCP_REQUEST_TIMEOUT_MS = readNumberEnv("MCP_REQUEST_TIMEOUT_MS", 30000, { min: 0 });

const CACHE_TTL_SECONDS = readNumberEnv("CACHE_TTL_SECONDS", 300, { min: 0 });
const CACHEABLE_TOOLS = new Set(
  (process.env.CACHEABLE_TOOLS || "campaign-calender,available-coupons")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);

const AUTO_CLAIM_CHECK_MINUTES = readNumberEnv("AUTO_CLAIM_CHECK_MINUTES", 10, { min: 0 });
const AUTO_CLAIM_HOUR = normalizeHour(readNumberEnv("AUTO_CLAIM_HOUR", 9), 9);
const AUTO_CLAIM_TIMEZONE = process.env.AUTO_CLAIM_TIMEZONE || "Asia/Shanghai";
const AUTO_CLAIM_SPREAD_MINUTES = readNumberEnv("AUTO_CLAIM_SPREAD_MINUTES", 600, { min: 0 });
const AUTO_CLAIM_SPREAD_RERUN_MINUTES = readNumberEnv("AUTO_CLAIM_SPREAD_RERUN_MINUTES", 120, { min: 0 });
const AUTO_CLAIM_MAX_PER_SWEEP = readNumberEnv("AUTO_CLAIM_MAX_PER_SWEEP", 10, { min: 0 });
const AUTO_CLAIM_REQUEST_GAP_MS = readNumberEnv("AUTO_CLAIM_REQUEST_GAP_MS", 1500, { min: 0 });
const GLOBAL_BURST_WINDOW_MINUTES = readNumberEnv("GLOBAL_BURST_WINDOW_MINUTES", 30, { min: 0 });
const GLOBAL_BURST_CHECK_SECONDS = readNumberEnv("GLOBAL_BURST_CHECK_SECONDS", 60, { min: 0 });
const SWEEP_WATCHDOG_SECONDS = readNumberEnv("SWEEP_WATCHDOG_SECONDS", 60, { min: 0 });
const SWEEP_STALE_MULTIPLIER = readNumberEnv("SWEEP_STALE_MULTIPLIER", 2, { min: 0 });
const AUTO_CLAIM_DEBUG = readBooleanEnv("AUTO_CLAIM_DEBUG", false);
const ADMIN_TELEGRAM_IDS = new Set(
  (process.env.ADMIN_TELEGRAM_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);

const cache = new TTLCache(CACHE_TTL_SECONDS * 1000);
const telegraphCache = new TTLCache(CACHE_TTL_SECONDS * 1000);
const bot = new Telegraf(BOT_TOKEN);
let autoClaimInterval = null;
let burstInterval = null;
let watchdogInterval = null;

function logAutoClaim(message, extra) {
  if (extra !== undefined) {
    console.log(`[auto-claim] ${message}`, extra);
    return;
  }
  console.log(`[auto-claim] ${message}`);
}

function logAutoClaimDebug(message, extra) {
  if (!AUTO_CLAIM_DEBUG) {
    return;
  }
  if (extra !== undefined) {
    console.log(`[auto-claim][debug] ${message}`, extra);
    return;
  }
  console.log(`[auto-claim][debug] ${message}`);
}

function formatMinutesSinceMidnight(minutes) {
  if (!Number.isFinite(minutes)) {
    return "unknown";
  }
  const hour = Math.floor(minutes / 60) % 24;
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function formatSkipStats(stats) {
  return Object.entries(stats)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

const TOKEN_GUIDE_MESSAGE = [
  "先获取麦当劳 MCP Token：",
  "1) 打开 https://open.mcd.cn/mcp",
  "2) 右上角登录（手机号验证）",
  "3) 登录后点击“控制台”，点击激活申请 MCP Token",
  "4) 同意协议后复制 Token"
].join("\n");

const ACCOUNT_HELP_MESSAGE = [
  "账号管理：",
  "/account add 名称 Token - 添加或更新账号",
  "/account use 名称 - 切换账号",
  "/account list - 查看账号",
  "/account del 名称 - 删除账号",
  "/autoclaim on|off [名称] - 自动领券开关",
  "/autoclaimreport success|fail on|off [名称] - 汇报开关",
  "提示：名称不要包含空格"
].join("\n");

const MAIN_MENU = Markup.inlineKeyboard([
  [Markup.button.callback("活动日历（本月）", "menu_calendar"), Markup.button.callback("可领优惠券", "menu_available")],
  [Markup.button.callback("一键领券", "menu_claim"), Markup.button.callback("我的优惠券", "menu_mycoupons")],
  [Markup.button.callback("账号状态", "menu_status"), Markup.button.callback("我的统计", "menu_stats")],
  [Markup.button.callback("账号管理", "menu_accounts"), Markup.button.callback("Token 获取指引", "menu_token_help")],
  [Markup.button.callback("开启自动领券", "menu_autoclaim_on"), Markup.button.callback("关闭自动领券", "menu_autoclaim_off")],
  [Markup.button.callback("开启成功汇报", "menu_report_success_on"), Markup.button.callback("关闭成功汇报", "menu_report_success_off")],
  [Markup.button.callback("开启失败汇报", "menu_report_fail_on"), Markup.button.callback("关闭失败汇报", "menu_report_fail_off")]
]);

function chunkText(text, maxLength = 3500) {
  const lines = text.split("\n");
  const chunks = [];
  let current = "";

  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > maxLength && current) {
      chunks.push(current);
      current = line;
      continue;
    }
    if (next.length > maxLength) {
      let remaining = line;
      while (remaining.length > maxLength) {
        chunks.push(remaining.slice(0, maxLength));
        remaining = remaining.slice(maxLength);
      }
      current = remaining;
      continue;
    }
    current = next;
  }

  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function stripHtmlTags(text) {
  return text.replace(/<[^>]+>/g, "");
}

async function sendLongMessage(ctx, text, options = {}) {
  const parseMode = options.parseMode || "HTML";
  const chunks = chunkText(text);
  for (const chunk of chunks) {
    try {
      await ctx.reply(chunk, {
        disable_web_page_preview: true,
        parse_mode: parseMode
      });
    } catch (error) {
      await ctx.reply(stripHtmlTags(chunk), {
        disable_web_page_preview: true
      });
    }
  }
}

async function sendLongMessageToUser(userId, text, options = {}) {
  const parseMode = options.parseMode || "HTML";
  const chunks = chunkText(text);
  for (const chunk of chunks) {
    try {
      await bot.telegram.sendMessage(userId, chunk, {
        disable_web_page_preview: true,
        parse_mode: parseMode
      });
    } catch (error) {
      await bot.telegram.sendMessage(userId, stripHtmlTags(chunk), {
        disable_web_page_preview: true
      });
    }
  }
}

async function sendPlainMessageToUser(userId, text) {
  const chunks = chunkText(text);
  for (const chunk of chunks) {
    await bot.telegram.sendMessage(userId, chunk, { disable_web_page_preview: true });
  }
}

function getToolRawText(result) {
  let rawText = "";

  if (typeof result === "string") {
    rawText = result;
  } else if (result && Array.isArray(result.content)) {
    const parts = [];
    for (const item of result.content) {
      if (!item) {
        continue;
      }
      if (item.type === "text" && item.text) {
        parts.push(item.text);
        continue;
      }
      if (item.type === "image") {
        if (item.url) {
          parts.push(item.url);
        } else if (item.data) {
          parts.push("图片内容已省略");
        }
      }
    }
    rawText = parts.join("\n\n").trim();
  } else {
    try {
      rawText = JSON.stringify(result, null, 2);
    } catch (error) {
      rawText = String(result);
    }
  }

  if (!rawText) {
    return "";
  }

  return rawText;
}

function normalizeToolText(rawText, options = {}) {
  if (!rawText) {
    return "";
  }

  let text = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/^\s*如果当前的 Client 支持 Markdown 渲染.*$/gm, "");
  text = text.replace(/^\s*请你把下面响应的内容以 Markdown 格式返回给用户[:：]?\s*$/gm, "");
  text = text.replace(/```(?:\w+)?\n([\s\S]*?)```/g, "$1");
  text = text.replace(/```/g, "");
  text = text.replace(/\\\s*$/gm, "");
  if (text.includes("\\n")) {
    text = text.replace(/\\n/g, "\n");
  }
  text = text.replace(/\n{3,}/g, "\n\n");

  if (options.removeTimeInfo) {
    text = text
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return true;
        }
        return !/^#{1,6}\s*当前时间[:：]/.test(trimmed) && !/^当前时间[:：]/.test(trimmed);
      })
      .join("\n");
  }

  if (options.removeClaimStatus) {
    text = text
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return true;
        }
        return !/(领取状态|是否已领取|已领取|未领取)/.test(trimmed);
      })
      .join("\n");
  }

  return text.trim();
}

function normalizeCalendarText(rawText) {
  return normalizeToolText(rawText, { removeTimeInfo: true });
}

function normalizeCouponListText(rawText) {
  return normalizeToolText(rawText, { removeClaimStatus: true });
}

function normalizeMyCouponsText(rawText) {
  const text = normalizeToolText(rawText);
  if (!text) {
    return "";
  }
  const lines = text.split("\n");
  const cleaned = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      cleaned.push(line);
      continue;
    }
    if (/^您的优惠券列表/.test(trimmed)) {
      continue;
    }
    if (/^共\s*\d+\s*张可用优惠券/.test(trimmed)) {
      continue;
    }
    if (
      /张可用优惠券/.test(trimmed) &&
      (/第\s*\d+\s*\/\s*\d+\s*页/.test(trimmed) || /每页\s*\d+\s*条/.test(trimmed))
    ) {
      continue;
    }
    if (/^图片[:：]/i.test(trimmed) || /图片内容已省略/.test(trimmed)) {
      continue;
    }
    if (/^https?:\/\/\S+\.(png|jpe?g|webp|gif)(\?\S*)?$/i.test(trimmed)) {
      continue;
    }
    cleaned.push(line);
  }
  return cleaned.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function simplifyClaimResultText(text) {
  if (!text) {
    return "";
  }
  const lines = text.split("\n");
  const cleaned = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      cleaned.push(line);
      continue;
    }
    if (/couponId[:：]/i.test(trimmed) || /couponCode[:：]/i.test(trimmed)) {
      continue;
    }
    if (/^图片[:：]/i.test(trimmed) || /图片内容已省略/.test(trimmed)) {
      continue;
    }
    if (/(领取状态|是否已领取|已领取|未领取)/.test(trimmed)) {
      continue;
    }
    const bulletMatch = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bulletMatch) {
      const indent = bulletMatch[1].length;
      const content = bulletMatch[2].trim();
      if (indent > 0) {
        continue;
      }
      if (/(couponId|couponCode|图片|领取状态|是否已领取|已领取|未领取)/i.test(content)) {
        continue;
      }
    }
    cleaned.push(line);
  }
  return cleaned.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function getClaimedCouponCount(rawText) {
  if (!rawText) {
    return 0;
  }
  const counts = parseClaimCounts(rawText);
  if (counts && Number.isFinite(counts.success)) {
    return counts.success;
  }
  const ids = parseCouponIds(rawText);
  return ids.length;
}

function incrementUserStats(userId, delta) {
  const user = getUser(userId) || {};
  const current = user.stats || {};
  const autoClaimRuns = Number(current.autoClaimRuns) || 0;
  const manualClaimRuns = Number(current.manualClaimRuns) || 0;
  const couponsClaimed = Number(current.couponsClaimed) || 0;
  const updated = {
    autoClaimRuns: autoClaimRuns + (delta.autoClaimRuns || 0),
    manualClaimRuns: manualClaimRuns + (delta.manualClaimRuns || 0),
    couponsClaimed: couponsClaimed + (delta.couponsClaimed || 0)
  };
  upsertUser(userId, { stats: updated });
  return updated;
}

function parseClaimCounts(rawText) {
  if (!rawText) {
    return null;
  }
  const normalized = rawText.replace(/\*/g, "");
  const getCount = (label) => {
    const match = normalized.match(new RegExp(`${label}\\s*[:：]\\s*(\\d+)`));
    return match ? Number(match[1]) : null;
  };

  const total = getCount("总计");
  const success = getCount("成功");
  const failed = getCount("失败");

  if (total === null && success === null && failed === null) {
    return null;
  }

  return { total, success, failed };
}

function hasClaimedCoupons(rawText) {
  const counts = parseClaimCounts(rawText);
  if (counts && Number.isFinite(counts.success)) {
    return counts.success > 0;
  }
  if (/couponId[:：]/i.test(rawText) || /couponCode[:：]/i.test(rawText)) {
    return true;
  }
  if (/成功领取/.test(rawText)) {
    return true;
  }
  return false;
}

function isAuthFailureMessage(message) {
  if (!message) {
    return false;
  }
  const text = String(message);
  return (
    /\b401\b/.test(text) ||
    /鉴权码/.test(text) ||
    /token.*(无效|失效)/i.test(text) ||
    /unauthorized|authorization/i.test(text)
  );
}

function parseCouponIds(rawText) {
  if (!rawText) {
    return [];
  }
  const ids = new Set();
  const regex = /couponId[:：]\s*([0-9a-zA-Z]+)/g;
  let match;
  while ((match = regex.exec(rawText))) {
    ids.add(match[1].toUpperCase());
  }
  return Array.from(ids);
}

function recordClaimedCoupons(rawText, trigger) {
  const couponIds = parseCouponIds(rawText);
  if (!couponIds.length) {
    return { newCouponIds: [], couponIds: [] };
  }

  const state = getGlobalState();
  const knownCoupons = state.knownCoupons || {};
  const updated = { ...knownCoupons };
  const nowIso = new Date().toISOString();
  const newCouponIds = [];

  for (const id of couponIds) {
    if (!updated[id]) {
      updated[id] = nowIso;
      newCouponIds.push(id);
    }
  }

  if (newCouponIds.length) {
    const nowMs = Date.now();
    const windowMinutes = Number.isFinite(GLOBAL_BURST_WINDOW_MINUTES) ? GLOBAL_BURST_WINDOW_MINUTES : 0;
    const burst =
      windowMinutes > 0
        ? {
            id: `burst_${nowMs}`,
            startAt: nowMs,
            endAt: nowMs + windowMinutes * 60 * 1000,
            windowMinutes,
            couponIds: newCouponIds,
            triggeredAt: nowIso,
            triggeredBy: trigger || null
          }
        : null;

    updateGlobalState({
      knownCoupons: updated,
      burst
    });
    if (burst) {
      logAutoClaim(`Burst window started: ${newCouponIds.length} new coupons, ${windowMinutes} minutes.`);
      ensureBurstScheduler(true);
    }
  }

  return { newCouponIds, couponIds };
}

function stripImagesFromText(text) {
  if (!text) {
    return "";
  }
  const lines = text.split("\n");
  const cleaned = [];
  for (const line of lines) {
    if (/<img\\b/i.test(line)) {
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      cleaned.push(line);
      continue;
    }
    if (/^(图片|优惠券图片|活动图片介绍|图片介绍)[:：]?$/i.test(trimmed)) {
      continue;
    }
    if (/^(图片|优惠券图片|活动图片介绍|图片介绍)[:：]\\s*$/i.test(trimmed)) {
      continue;
    }
    cleaned.push(line);
  }
  return cleaned.join("\n").replace(/\n{3,}/g, "\n\n");
}

function formatToolResult(result, options = {}) {
  const rawText = normalizeToolText(getToolRawText(result), options.normalizeOptions);
  if (!rawText) {
    return "";
  }
  const removeImages = options.removeImages !== false;
  const text = removeImages ? stripImagesFromText(rawText) : rawText;
  return formatTelegramHtml(text);
}

function formatTelegramHtml(text) {
  const { text: withoutImages, images } = replaceImages(text);
  const codeBlocks = [];

  let processed = withoutImages.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
    const escapedCode = escapeHtml(code.trim());
    const htmlBlock = `<pre><code>${escapedCode}</code></pre>`;
    const key = `__CODE_BLOCK_${codeBlocks.length}__`;
    codeBlocks.push(htmlBlock);
    return key;
  });

  processed = escapeHtml(processed);

  const lines = processed.split("\n").map((line) => {
    const trimmed = line.trimEnd();
    if (/^#{1,6}\s+/.test(trimmed)) {
      const title = trimmed.replace(/^#{1,6}\s+/, "");
      return `<b>${title}</b>`;
    }
    if (/^-{3,}$/.test(trimmed)) {
      return "────────";
    }
    if (/^\s*[-*+]\s+/.test(trimmed)) {
      return trimmed.replace(/^(\s*)[-*+]\s+/, "$1• ");
    }
    return trimmed;
  });

  processed = lines.join("\n");
  processed = processed.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  processed = processed.replace(/`([^`]+)`/g, "<code>$1</code>");

  codeBlocks.forEach((block, index) => {
    processed = processed.replace(new RegExp(`__CODE_BLOCK_${index}__`, "g"), block);
  });

  images.forEach((url, index) => {
    const safeUrl = escapeHtml(url);
    const link = `<a href=\"${safeUrl}\">查看图片</a>`;
    processed = processed.replace(new RegExp(`__IMAGE_${index}__`, "g"), link);
  });

  return processed;
}

function replaceImages(text) {
  const images = [];
  const replaced = text.replace(/<img[^>]*src=[\"']([^\"']+)[\"'][^>]*>/gi, (match, url) => {
    const key = `__IMAGE_${images.length}__`;
    images.push(url);
    return `图片：${key}`;
  });
  return { text: replaced, images };
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function parseInlineNodes(text) {
  if (!text) {
    return [""];
  }
  const segments = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return segments.map((segment) => {
    if (segment.startsWith("**") && segment.endsWith("**")) {
      const inner = segment.slice(2, -2);
      return { tag: "strong", children: [inner] };
    }
    if (segment.startsWith("`") && segment.endsWith("`")) {
      const inner = segment.slice(1, -1);
      return { tag: "code", children: [inner] };
    }
    return segment;
  });
}

function buildTelegraphNodes(text) {
  const nodes = [];
  const lines = text.split("\n");
  let listItems = null;

  const flushList = () => {
    if (listItems && listItems.length) {
      nodes.push({ tag: "ul", children: listItems });
    }
    listItems = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushList();
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushList();
      const level = headingMatch[1].length;
      const tag = `h${Math.min(level, 4)}`;
      nodes.push({ tag, children: parseInlineNodes(stripHtmlTags(headingMatch[2])) });
      continue;
    }

    if (/^-{3,}$/.test(trimmed)) {
      flushList();
      nodes.push({ tag: "hr" });
      continue;
    }

    const imgMatches = [...trimmed.matchAll(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi)];
    if (imgMatches.length) {
      flushList();
      const textWithoutImg = stripHtmlTags(trimmed.replace(/<img[^>]*>/gi, "")).trim();
      if (textWithoutImg && !/^(图片|优惠券图片|活动图片介绍|图片介绍)[:：]?$/i.test(textWithoutImg)) {
        nodes.push({ tag: "p", children: parseInlineNodes(textWithoutImg) });
      }
      for (const match of imgMatches) {
        nodes.push({ tag: "img", attrs: { src: match[1] } });
      }
      continue;
    }

    const bulletMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (bulletMatch) {
      if (!listItems) {
        listItems = [];
      }
      listItems.push({ tag: "li", children: parseInlineNodes(stripHtmlTags(bulletMatch[1])) });
      continue;
    }

    flushList();
    nodes.push({ tag: "p", children: parseInlineNodes(stripHtmlTags(trimmed)) });
  }

  flushList();
  return nodes;
}

function parseCommandArgs(ctx) {
  const text = ctx.message && ctx.message.text ? ctx.message.text : "";
  return text.split(/\s+/).slice(1).filter(Boolean);
}

function formatTimestamp(ms, timeZone) {
  if (!ms) {
    return "无";
  }
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return "无";
  }
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const parts = formatter.formatToParts(date);
  const map = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      map[part.type] = part.value;
    }
  }
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
}

function formatSignedDelta(delta) {
  const safeDelta = Number.isFinite(delta) ? delta : 0;
  const sign = safeDelta >= 0 ? "+" : "-";
  return `(${sign}${Math.abs(safeDelta)})`;
}

function formatCountWithDelta(value, baseline) {
  const current = Number.isFinite(value) ? value : 0;
  const base = Number.isFinite(baseline) ? baseline : current;
  return `${current} ${formatSignedDelta(current - base)}`;
}

function getAdminSettings() {
  const state = getGlobalState();
  return state.admin || {};
}

function isAdminErrorPushEnabled() {
  const settings = getAdminSettings();
  return Boolean(settings.errorPushEnabled);
}

function updateAdminSettings(updates) {
  const state = getGlobalState();
  const admin = { ...(state.admin || {}), ...updates };
  updateGlobalState({ admin });
  return admin;
}

async function notifyAdmins(message) {
  if (!isAdminErrorPushEnabled()) {
    return;
  }
  if (!ADMIN_TELEGRAM_IDS.size) {
    return;
  }
  for (const adminId of ADMIN_TELEGRAM_IDS) {
    try {
      await sendPlainMessageToUser(adminId, message);
    } catch (error) {
      console.error("Failed to send admin notification", error);
    }
  }
}

function ensureAdmin(ctx) {
  if (!ADMIN_TELEGRAM_IDS.size) {
    ctx.reply("未配置管理员 ID，请先设置 ADMIN_TELEGRAM_IDS。");
    return false;
  }
  const userId = ctx.from && ctx.from.id ? String(ctx.from.id) : "";
  if (!ADMIN_TELEGRAM_IDS.has(userId)) {
    ctx.reply("无权限使用该指令。");
    return false;
  }
  return true;
}

function getAccountDisplayName(accountId, account) {
  if (account && account.label) {
    return account.label;
  }
  if (accountId === "default") {
    return "默认账号";
  }
  return accountId;
}

function buildAccountListText(user) {
  const entries = user && user.accounts ? Object.entries(user.accounts) : [];
  if (entries.length === 0) {
    return "暂无账号，请先使用 /account add 添加账号。";
  }
  const lines = entries.map(([accountId, account]) => {
    const name = getAccountDisplayName(accountId, account);
    const active = user.activeAccountId === accountId ? "✅" : "▫️";
    const autoClaim = account.autoClaimEnabled ? "开" : "关";
    const reportSuccess = account.autoClaimReportSuccess ? "开" : "关";
    const reportFail = account.autoClaimReportFailure ? "开" : "关";
    const nameWithId = name === accountId ? name : `${name}（${accountId}）`;
    return `${active} ${nameWithId} ｜自动领券:${autoClaim} ｜汇报(成):${reportSuccess} ｜汇报(败):${reportFail}`;
  });
  return lines.join("\n");
}

function resolveAccount(userId, accountId) {
  const user = getUser(userId);
  if (!user || !user.accounts || Object.keys(user.accounts).length === 0) {
    return { error: "no_accounts" };
  }

  let resolvedId = accountId;
  if (resolvedId) {
    if (!user.accounts[resolvedId]) {
      return { error: "account_not_found", user };
    }
  } else {
    resolvedId = user.activeAccountId;
    if (!resolvedId || !user.accounts[resolvedId]) {
      const firstId = Object.keys(user.accounts)[0];
      if (firstId) {
        resolvedId = firstId;
        if (user.activeAccountId !== firstId) {
          upsertUser(userId, { activeAccountId: firstId });
        }
      }
    }
  }

  if (!resolvedId || !user.accounts[resolvedId]) {
    return { error: "account_not_found", user };
  }

  const account = user.accounts[resolvedId];
  if (!account || !account.token) {
    return { error: "missing_token", user, accountId: resolvedId };
  }

  return { user, accountId: resolvedId, account };
}

function getAccountInfo(userId, accountId) {
  const user = getUser(userId);
  if (!user || !user.accounts || !user.accounts[accountId]) {
    return null;
  }
  const account = user.accounts[accountId];
  if (!account || !account.token) {
    return null;
  }
  return { userId, accountId, account, displayName: getAccountDisplayName(accountId, account) };
}

function ensureAccount(ctx, accountId) {
  const userId = String(ctx.from.id);
  const info = resolveAccount(userId, accountId);

  if (info.error === "no_accounts") {
    ctx.reply("还没有添加账号，请先使用 /token 或 /account add 添加 MCP Token。");
    return null;
  }
  if (info.error === "account_not_found") {
    ctx.reply(`账号不存在：${accountId}`);
    return null;
  }
  if (info.error === "missing_token") {
    const name = getAccountDisplayName(info.accountId, info.user.accounts[info.accountId]);
    ctx.reply(`账号 ${name} 未设置 Token，请重新设置。`);
    return null;
  }

  return { ...info, userId, displayName: getAccountDisplayName(info.accountId, info.account) };
}

function addOrUpdateAccount(userId, accountId, token, label) {
  const user = getUser(userId) || {};
  const accounts = { ...(user.accounts || {}) };
  const existingAccount = accounts[accountId];
  const isNewAccount = !existingAccount;
  const existing = existingAccount || {};
  const defaultAutoClaimEnabled = isNewAccount;
  const updated = {
    ...existing,
    token,
    label: label || existing.label || accountId,
    autoClaimEnabled:
      typeof existing.autoClaimEnabled === "boolean" ? existing.autoClaimEnabled : defaultAutoClaimEnabled,
    autoClaimReportSuccess: typeof existing.autoClaimReportSuccess === "boolean" ? existing.autoClaimReportSuccess : true,
    autoClaimReportFailure: typeof existing.autoClaimReportFailure === "boolean" ? existing.autoClaimReportFailure : true
  };

  accounts[accountId] = updated;
  const activeAccountId = user.activeAccountId || accountId;
  upsertUser(userId, { accounts, activeAccountId });
  return { existed: Boolean(existing && existing.token), isNewAccount };
}

function updateAccount(userId, accountId, updates) {
  const user = getUser(userId);
  if (!user || !user.accounts || !user.accounts[accountId]) {
    return false;
  }
  const accounts = { ...user.accounts };
  accounts[accountId] = { ...accounts[accountId], ...updates };
  upsertUser(userId, { accounts });
  return true;
}

function removeAccount(userId, accountId) {
  const user = getUser(userId);
  if (!user || !user.accounts || !user.accounts[accountId]) {
    return false;
  }
  const accounts = { ...user.accounts };
  delete accounts[accountId];
  const remainingIds = Object.keys(accounts);
  const activeAccountId = remainingIds.includes(user.activeAccountId)
    ? user.activeAccountId
    : remainingIds[0] || null;
  upsertUser(userId, { accounts, activeAccountId });
  return true;
}

function getToolCacheKey(toolName, args) {
  return `${toolName}:${JSON.stringify(args || {})}`;
}

async function callToolWithToken(token, toolName, args) {
  if (!token) {
    throw new Error("缺少 MCP Token，请先设置。");
  }

  const cacheKey = getToolCacheKey(toolName, args);
  const useCache = CACHEABLE_TOOLS.has(toolName);
  if (useCache) {
    const cached = cache.get(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const client = new MCPClient({
    baseUrl: MCP_URL,
    token,
    protocolVersion: MCP_PROTOCOL_VERSION,
    requestTimeoutMs: MCP_REQUEST_TIMEOUT_MS
  });

  const result = await client.callTool(toolName, args || {});
  if (useCache) {
    cache.set(cacheKey, result);
  }
  return result;
}

async function validateToken(token) {
  if (!token) {
    return { ok: false, authFailure: true, message: "缺少 MCP Token，请先设置。" };
  }
  try {
    const client = new MCPClient({
      baseUrl: MCP_URL,
      token,
      protocolVersion: MCP_PROTOCOL_VERSION,
      requestTimeoutMs: MCP_REQUEST_TIMEOUT_MS
    });
    await client.callTool("my-coupons", {});
    return { ok: true };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (isAuthFailureMessage(message)) {
      return { ok: false, authFailure: true, message };
    }
    return { ok: false, authFailure: false, message };
  }
}

bot.catch((error, ctx) => {
  console.error("Bot error", error);
  const message = error && error.message ? error.message : "";
  const isOldQueryError =
    message.includes("query is too old") ||
    message.includes("response timeout expired") ||
    (error.description && error.description.includes("query is too old"));
  if (!isOldQueryError) {
    notifyAdmins(`Bot 运行异常：${message}`);
  }
  if (ctx && ctx.reply) {
    ctx.reply("出错了，请稍后再试。");
  }
});

bot.start((ctx) => {
  const message = [
    "欢迎使用麦麦 MCP 机器人。",
    "",
    TOKEN_GUIDE_MESSAGE,
    "",
    "在这里发送：",
    "/token 你的MCP_TOKEN（首次会创建默认账号）",
    "",
    "指令：",
    "/calendar [YYYY-MM-DD] - 活动日历查询",
    "/coupons - 麦麦省可领取券列表",
    "/claim - 麦麦省一键领券",
    "/mycoupons - 我的优惠券",
    "/autoclaim on|off [账号名] - 每日自动领券",
    "/autoclaimreport success|fail on|off [账号名] - 自动领券结果汇报",
    "/account add 名称 Token - 添加账号",
    "/account use 名称 - 切换账号",
    "/account list - 查看账号",
    "/account del 名称 - 删除账号",
    "/status - 查看账号状态",
    "/stats - 我的领券统计",
    "/cleartoken - 清空全部账号"
  ].join("\n");
  ctx.reply(message, { disable_web_page_preview: true, ...MAIN_MENU });
});

bot.command("menu", (ctx) => {
  ctx.reply("请选择功能：", { disable_web_page_preview: true, ...MAIN_MENU });
});

function sendAccountHelp(ctx) {
  const userId = String(ctx.from.id);
  const user = getUser(userId);
  const listText = user ? buildAccountListText(user) : "暂无账号，请先使用 /account add 添加账号。";
  ctx.reply(`${ACCOUNT_HELP_MESSAGE}\n\n${listText}`);
}

async function handleAccountCommand(ctx, args) {
  const userId = String(ctx.from.id);
  const sub = args[0] ? args[0].toLowerCase() : "";

  if (!sub || sub === "help") {
    sendAccountHelp(ctx);
    return;
  }

  if (sub === "list") {
    sendAccountHelp(ctx);
    return;
  }

  if (sub === "add") {
    const accountId = args[1];
    const token = args.slice(2).join(" ").trim();
    if (!accountId || !token) {
      ctx.reply("用法：/account add 名称 Token");
      return;
    }
    const validation = await validateToken(token);
    if (!validation.ok && validation.authFailure) {
      ctx.reply(`账号 ${accountId} Token 无效或已失效，请重新获取。`);
      return;
    }
    const result = addOrUpdateAccount(userId, accountId, token, accountId);
    const { existed, isNewAccount } = result;
    if (!validation.ok) {
      ctx.reply(
        `${existed ? "账号已更新" : "账号已添加"}，但暂时无法验证 Token：${validation.message}`
      );
      return;
    }
    ctx.reply(existed ? `账号 ${accountId} 已更新。` : `账号 ${accountId} 已添加。`);
    if (isNewAccount) {
      const info = getAccountInfo(userId, accountId);
      if (info && info.account.autoClaimEnabled) {
        runImmediateAutoClaim(ctx, info).catch((error) => {
          console.error("Immediate auto-claim failed", error);
        });
      }
    }
    return;
  }

  if (sub === "use") {
    const accountId = args[1];
    if (!accountId) {
      ctx.reply("用法：/account use 名称");
      return;
    }
    const user = getUser(userId);
    if (!user || !user.accounts || !user.accounts[accountId]) {
      ctx.reply(`账号不存在：${accountId}`);
      return;
    }
    upsertUser(userId, { activeAccountId: accountId });
    ctx.reply(`已切换到账号：${getAccountDisplayName(accountId, user.accounts[accountId])}`);
    return;
  }

  if (sub === "del" || sub === "delete" || sub === "rm") {
    const accountId = args[1];
    if (!accountId) {
      ctx.reply("用法：/account del 名称");
      return;
    }
    const removed = removeAccount(userId, accountId);
    ctx.reply(removed ? `账号 ${accountId} 已删除。` : `账号不存在：${accountId}`);
    return;
  }

  ctx.reply("未知子命令。\n" + ACCOUNT_HELP_MESSAGE);
}

bot.command(["token", "settoken"], async (ctx) => {
  const args = parseCommandArgs(ctx);
  const sub = args[0] ? args[0].toLowerCase() : "";
  if (["add", "use", "list", "del", "delete", "rm", "help"].includes(sub)) {
    await handleAccountCommand(ctx, args);
    return;
  }

  const token = args.join(" ").trim();
  if (!token) {
    ctx.reply("用法：/token 你的MCP_TOKEN");
    return;
  }

  const userId = String(ctx.from.id);
  const user = getUser(userId);
  const accountId = user && user.activeAccountId ? user.activeAccountId : "default";
  const validation = await validateToken(token);
  if (!validation.ok && validation.authFailure) {
    ctx.reply("Token 无效或已失效，请重新获取。");
    return;
  }
  const result = addOrUpdateAccount(userId, accountId, token, accountId === "default" ? "默认账号" : accountId);
  const { existed, isNewAccount } = result;
  if (!validation.ok) {
    ctx.reply(`${existed ? "Token 已更新" : "Token 已保存"}，但暂时无法验证：${validation.message}`);
    return;
  }
  ctx.reply(existed ? "Token 已更新，可以继续使用。" : "Token 已保存，可以开始使用指令了。");
  if (isNewAccount) {
    const info = getAccountInfo(userId, accountId);
    if (info && info.account.autoClaimEnabled) {
      runImmediateAutoClaim(ctx, info).catch((error) => {
        console.error("Immediate auto-claim failed", error);
      });
    }
  }
});

bot.command(["account", "accounts"], async (ctx) => {
  const args = parseCommandArgs(ctx);
  await handleAccountCommand(ctx, args);
});

bot.command("cleartoken", (ctx) => {
  const userId = String(ctx.from.id);
  const existing = getUser(userId);
  if (!existing) {
    ctx.reply("未找到已保存的账号。");
    return;
  }
  deleteUser(userId);
  ctx.reply("已清空全部账号。");
});

function sendStatus(ctx) {
  const userId = String(ctx.from.id);
  const user = getUser(userId);
  if (!user || !user.accounts || Object.keys(user.accounts).length === 0) {
    ctx.reply("还没有添加账号，请先使用 /token 或 /account add 设置。");
    return;
  }
  const activeId = user.activeAccountId;
  const activeAccount = activeId ? user.accounts[activeId] : null;
  const activeName = activeAccount ? getAccountDisplayName(activeId, activeAccount) : "未选择";
  const autoClaimStatus = activeAccount && activeAccount.autoClaimEnabled ? "已开启" : "已关闭";
  const reportSuccessStatus = activeAccount && activeAccount.autoClaimReportSuccess ? "已开启" : "已关闭";
  const reportFailureStatus = activeAccount && activeAccount.autoClaimReportFailure ? "已开启" : "已关闭";
  const lastRun = activeAccount && activeAccount.lastAutoClaimAt ? activeAccount.lastAutoClaimAt : "从未执行";
  const listText = buildAccountListText(user);

  ctx.reply(
    [
      `当前账号：${activeName}`,
      `自动领券：${autoClaimStatus}`,
      `成功汇报：${reportSuccessStatus}`,
      `失败汇报：${reportFailureStatus}`,
      `上次自动领券：${lastRun}`,
      "",
      "账号列表：",
      listText
    ].join("\n")
  );
}

bot.command("status", sendStatus);

function sendStats(ctx) {
  const userId = String(ctx.from.id);
  const user = getUser(userId);
  const stats = user && user.stats ? user.stats : { autoClaimRuns: 0, manualClaimRuns: 0, couponsClaimed: 0 };
  ctx.reply(
    [
      "我的领券统计：",
      `自动领券次数：${stats.autoClaimRuns || 0}`,
      `手动领券次数：${stats.manualClaimRuns || 0}`,
      `累计领取优惠券：${stats.couponsClaimed || 0}`
    ].join("\n")
  );
}

bot.command("stats", sendStats);

function computeAdminMetrics(today) {
  const users = allUsers();
  const metrics = {
    userCount: Object.keys(users).length,
    accountCount: 0,
    autoClaimEnabledCount: 0,
    autoClaimDisabledCount: 0,
    doneCount: 0,
    pendingCount: 0,
    todayAutoClaimSuccess: 0,
    todayAutoClaimFailureAuth: 0,
    todayAutoClaimFailureOther: 0,
    totalAutoClaimRuns: 0,
    totalManualClaimRuns: 0,
    totalCouponsClaimed: 0,
    knownCouponsCount: 0
  };

  for (const user of Object.values(users)) {
    const accounts = user.accounts || {};
    const entries = Object.values(accounts);
    metrics.accountCount += entries.length;
    for (const account of entries) {
      if (!account) {
        continue;
      }
      const ranToday = account.lastAutoClaimDate === today;
      if (ranToday && account.lastAutoClaimStatus) {
        const status = String(account.lastAutoClaimStatus);
        if (status.startsWith("成功")) {
          metrics.todayAutoClaimSuccess += 1;
        } else if (status.startsWith("失败")) {
          const reason = status.replace(/^失败[:：]\s*/, "");
          if (isAuthFailureMessage(reason) || isAuthFailureMessage(status)) {
            metrics.todayAutoClaimFailureAuth += 1;
          } else {
            metrics.todayAutoClaimFailureOther += 1;
          }
        }
      }
      if (account.autoClaimEnabled) {
        metrics.autoClaimEnabledCount += 1;
        if (ranToday) {
          metrics.doneCount += 1;
        } else {
          metrics.pendingCount += 1;
        }
      } else {
        metrics.autoClaimDisabledCount += 1;
      }
    }

    const stats = user.stats || {};
    metrics.totalAutoClaimRuns += Number(stats.autoClaimRuns) || 0;
    metrics.totalManualClaimRuns += Number(stats.manualClaimRuns) || 0;
    metrics.totalCouponsClaimed += Number(stats.couponsClaimed) || 0;
  }

  const state = getGlobalState();
  metrics.knownCouponsCount = state.knownCoupons ? Object.keys(state.knownCoupons).length : 0;

  return metrics;
}

function getAdminSummaryBaseline(today, metrics) {
  const state = getGlobalState();
  const snapshot = state.adminSummarySnapshot;
  if (snapshot && snapshot.date === today && snapshot.metrics && typeof snapshot.metrics === "object") {
    return snapshot.metrics;
  }
  const baseline = { ...(metrics || computeAdminMetrics(today)) };
  updateGlobalState({ adminSummarySnapshot: { date: today, metrics: baseline } });
  return baseline;
}

bot.command("admin", (ctx) => {
  if (!ensureAdmin(ctx)) {
    return;
  }
  const args = parseCommandArgs(ctx);
  const sub = args[0] ? args[0].toLowerCase() : "";

  if (sub === "notify" || sub === "push" || sub === "alert") {
    const setting = args[1] ? args[1].toLowerCase() : "";
    if (setting !== "on" && setting !== "off") {
      ctx.reply("用法：/admin notify on|off");
      return;
    }
    const enabled = setting === "on";
    updateAdminSettings({ errorPushEnabled: enabled });
    ctx.reply(`管理员报错推送已${enabled ? "开启" : "关闭"}。`);
    return;
  }

  if (
    !sub ||
    sub === "summary" ||
    sub === "users" ||
    sub === "stats" ||
    sub === "count" ||
    sub === "status"
  ) {
    const today = getLocalDate(AUTO_CLAIM_TIMEZONE);
    const metrics = computeAdminMetrics(today);
    const baseline = getAdminSummaryBaseline(today, metrics);
    const totalFailure = metrics.todayAutoClaimFailureAuth + metrics.todayAutoClaimFailureOther;
    const baselineFailure =
      (Number(baseline.todayAutoClaimFailureAuth) || 0) + (Number(baseline.todayAutoClaimFailureOther) || 0);
    const state = getGlobalState();
    const lastRequestAt = formatTimestamp(state.lastAutoClaimRequestAt, AUTO_CLAIM_TIMEZONE);
    const lastSweepStartedAt = formatTimestamp(state.lastSweepStartedAt, AUTO_CLAIM_TIMEZONE);
    const lastSweepFinishedAt = formatTimestamp(state.lastSweepFinishedAt, AUTO_CLAIM_TIMEZONE);
    const lastSweepDuration = state.lastSweepDurationMs
      ? `${Math.round(state.lastSweepDurationMs / 1000)}秒`
      : "无";
    const lastSweepProcessed = Number(state.lastSweepProcessed) || 0;
    const lastSweepEligible = Number(state.lastSweepEligible) || 0;
    const lastSweepReason = state.lastSweepReason || "无";
    const lastSweepError = state.lastSweepError || "无";

    const burst = getActiveBurst();
    const burstRemainingMs = burst ? Math.max(0, burst.endAt - Date.now()) : 0;
    const burstRemainingMinutes = burst ? Math.ceil(burstRemainingMs / 60000) : 0;
    const burstTriggeredAt = burst ? formatTimestamp(burst.startAt, AUTO_CLAIM_TIMEZONE) : "无";
    const burstCouponCount = burst && Array.isArray(burst.couponIds) ? burst.couponIds.length : 0;
    const burstStatus = burst
      ? `进行中（剩余约 ${burstRemainingMinutes} 分钟，券 ${burstCouponCount} 张，触发 ${burstTriggeredAt}）`
      : "无";

    const errorPushStatus = isAdminErrorPushEnabled() ? "开" : "关";
    const rerunWindow = AUTO_CLAIM_SPREAD_RERUN_MINUTES
      ? `已执行账号 ${AUTO_CLAIM_SPREAD_RERUN_MINUTES} 分钟后允许重跑`
      : "不重复执行";

    ctx.reply(
      [
        "管理员概览：",
        `用户数：${formatCountWithDelta(metrics.userCount, baseline.userCount)}`,
        `账号数：${formatCountWithDelta(metrics.accountCount, baseline.accountCount)}`,
        `自动领券开启账号数：${formatCountWithDelta(metrics.autoClaimEnabledCount, baseline.autoClaimEnabledCount)}`,
        `自动领券关闭账号数：${formatCountWithDelta(metrics.autoClaimDisabledCount, baseline.autoClaimDisabledCount)}`,
        `今日已执行账号数：${formatCountWithDelta(metrics.doneCount, baseline.doneCount)}`,
        `今日待执行账号数：${formatCountWithDelta(metrics.pendingCount, baseline.pendingCount)}`,
        `今日自动领券成功数：${formatCountWithDelta(metrics.todayAutoClaimSuccess, baseline.todayAutoClaimSuccess)}`,
        `今日自动领券失败数：${formatCountWithDelta(totalFailure, baselineFailure)}（鉴权${formatCountWithDelta(
          metrics.todayAutoClaimFailureAuth,
          baseline.todayAutoClaimFailureAuth
        )}｜其他${formatCountWithDelta(metrics.todayAutoClaimFailureOther, baseline.todayAutoClaimFailureOther)}）`,
        `自动领券次数总计：${formatCountWithDelta(metrics.totalAutoClaimRuns, baseline.totalAutoClaimRuns)}`,
        `手动领券次数总计：${formatCountWithDelta(metrics.totalManualClaimRuns, baseline.totalManualClaimRuns)}`,
        `累计领取优惠券总计：${formatCountWithDelta(metrics.totalCouponsClaimed, baseline.totalCouponsClaimed)}`,
        `已记录券 ID 数量：${formatCountWithDelta(metrics.knownCouponsCount, baseline.knownCouponsCount)}`,
        `最近自动领券请求：${lastRequestAt}`,
        `最近 Sweep：开始 ${lastSweepStartedAt} ｜结束 ${lastSweepFinishedAt} ｜耗时 ${lastSweepDuration} ｜原因 ${lastSweepReason}`,
        `Sweep 进度：符合 ${lastSweepEligible} ｜已处理 ${lastSweepProcessed} ｜状态 ${autoClaimSweepInProgress ? "运行中" : "空闲"}`,
        `Sweep 错误：${lastSweepError}`,
        `Burst 窗口：${burstStatus}`,
        `报错推送：${errorPushStatus}`,
        `调度配置：检查${AUTO_CLAIM_CHECK_MINUTES}分钟｜起始${AUTO_CLAIM_HOUR}点｜分散${AUTO_CLAIM_SPREAD_MINUTES}分钟｜${rerunWindow}｜每轮上限${AUTO_CLAIM_MAX_PER_SWEEP}｜间隔${AUTO_CLAIM_REQUEST_GAP_MS}ms｜Burst${GLOBAL_BURST_WINDOW_MINUTES}分钟/检查${GLOBAL_BURST_CHECK_SECONDS}s｜时区${AUTO_CLAIM_TIMEZONE}`
      ].join("\n")
    );
    return;
  }

  if (sub === "sweep" || sub === "run") {
    runAutoClaimSweep()
      .then(() => {
        const state = getGlobalState();
        ctx.reply(
          [
            "手动触发 Sweep 完成：",
            `开始：${formatTimestamp(state.lastSweepStartedAt, AUTO_CLAIM_TIMEZONE)}`,
            `结束：${formatTimestamp(state.lastSweepFinishedAt, AUTO_CLAIM_TIMEZONE)}`,
            `耗时：${state.lastSweepDurationMs ? `${Math.round(state.lastSweepDurationMs / 1000)}秒` : "无"}`,
            `原因：${state.lastSweepReason || "无"}`,
            `符合：${state.lastSweepEligible || 0}`,
            `已处理：${state.lastSweepProcessed || 0}`,
            `错误：${state.lastSweepError || "无"}`
          ].join("\n")
        );
      })
      .catch((error) => {
        ctx.reply(`手动 Sweep 失败：${error.message}`);
      });
    return;
  }

  ctx.reply("用法：/admin | /admin notify on|off | /admin sweep");
});

function sendTokenGuide(ctx) {
  ctx.reply(TOKEN_GUIDE_MESSAGE, { disable_web_page_preview: true });
}

async function sendTelegraphArticle(ctx, title, rawText, fallbackPrefix, cacheKey) {
  const nodes = buildTelegraphNodes(rawText);
  if (!nodes.length) {
    await sendLongMessage(ctx, "未返回数据。");
    return;
  }

  try {
    if (cacheKey) {
      const cached = telegraphCache.get(cacheKey);
      if (cached) {
        const message = `<a href="${escapeHtml(cached)}">点击查看</a>`;
        await ctx.reply(message, {
          disable_web_page_preview: false,
          parse_mode: "HTML"
        });
        return;
      }
    }

    const url = await createTelegraphPage(title, nodes);
    if (cacheKey) {
      telegraphCache.set(cacheKey, url);
    }
    const message = `<a href="${escapeHtml(url)}">点击查看</a>`;
    await ctx.reply(message, {
      disable_web_page_preview: false,
      parse_mode: "HTML"
    });
  } catch (error) {
    const label = fallbackPrefix || title || "内容";
    const warning = `${label} Telegraph 生成失败，已改用文本展示：${error.message}`;
    await sendLongMessage(ctx, warning + "\n\n" + formatTelegramHtml(stripImagesFromText(rawText)));
  }
}

async function handleCalendar(ctx, specifiedDate) {
  const info = ensureAccount(ctx);
  if (!info) return;

  let args = {};
  if (specifiedDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(specifiedDate)) {
      ctx.reply("日期格式错误，请使用 YYYY-MM-DD。");
      return;
    }
    args = { specifiedDate };
  }

  try {
    const result = await callToolWithToken(info.account.token, "campaign-calender", args);
    const rawText = getToolRawText(result);
    const cleaned = normalizeCalendarText(rawText);
    const title = specifiedDate ? `麦当劳活动日历（${specifiedDate}）` : "麦当劳活动日历";
    const cacheKey = getToolCacheKey("campaign-calender", args);
    await sendTelegraphArticle(ctx, title, cleaned, "活动日历", cacheKey);
  } catch (error) {
    ctx.reply(`活动日历查询失败：${error.message}`);
  }
}

async function handleAvailableCoupons(ctx) {
  const info = ensureAccount(ctx);
  if (!info) return;

  try {
    const result = await callToolWithToken(info.account.token, "available-coupons", {});
    const rawText = getToolRawText(result);
    const cleaned = normalizeCouponListText(rawText);
    const cacheKey = getToolCacheKey("available-coupons", {});
    await sendTelegraphArticle(ctx, "麦麦省优惠券列表", cleaned, "优惠券列表", cacheKey);
  } catch (error) {
    ctx.reply(`优惠券列表查询失败：${error.message}`);
  }
}

async function handleClaimCoupons(ctx) {
  const info = ensureAccount(ctx);
  if (!info) return;

  try {
    const result = await callToolWithToken(info.account.token, "auto-bind-coupons", {});
    const rawText = getToolRawText(result);
    const normalized = normalizeToolText(rawText);
    const simplified = simplifyClaimResultText(normalized);
    const claimedCount = getClaimedCouponCount(normalized);
    recordClaimedCoupons(normalized, { userId: info.userId, accountId: info.accountId, reason: "manual" });
    incrementUserStats(info.userId, { manualClaimRuns: 1, couponsClaimed: claimedCount });
    const text = formatTelegramHtml(stripImagesFromText(simplified));
    await sendLongMessage(ctx, text || "未返回数据。");
  } catch (error) {
    ctx.reply(`一键领券失败：${error.message}`);
  }
}

async function runImmediateAutoClaim(ctx, info) {
  const taskKey = `${info.userId}:${info.accountId}`;
  if (autoClaimInProgress.has(taskKey)) {
    ctx.reply(`账号 ${info.displayName} 正在自动领券中，请稍后再试。`);
    return;
  }
  autoClaimInProgress.add(taskKey);
  const today = getLocalDate(AUTO_CLAIM_TIMEZONE);

  try {
    const result = await callToolWithToken(info.account.token, "auto-bind-coupons", {});
    const rawText = getToolRawText(result);
    const normalized = normalizeToolText(rawText);
    const simplified = simplifyClaimResultText(normalized);
    const claimedCount = getClaimedCouponCount(normalized);
    recordClaimedCoupons(normalized, { userId: info.userId, accountId: info.accountId, reason: "enable" });
    incrementUserStats(info.userId, { autoClaimRuns: 1, couponsClaimed: claimedCount });
    updateAccount(info.userId, info.accountId, {
      lastAutoClaimDate: today,
      lastAutoClaimAt: getLocalDateTime(AUTO_CLAIM_TIMEZONE),
      lastAutoClaimStatus: "成功",
      lastRerunAt: Date.now()
    });

    const text = [
      `自动领券结果（${today}）- 账号：${info.displayName}`,
      "",
      formatTelegramHtml(stripImagesFromText(simplified))
    ].join("\n");
    await sendLongMessage(ctx, text || "未返回数据。");
  } catch (error) {
    const message = error && error.message ? error.message : "未知错误";
    const authFailure = isAuthFailureMessage(message);
    const updates = {
      lastAutoClaimDate: today,
      lastAutoClaimAt: getLocalDateTime(AUTO_CLAIM_TIMEZONE),
      lastAutoClaimStatus: `失败：${message}`,
      lastRerunAt: Date.now()
    };
    if (authFailure) {
      updates.lastAuthFailureNotifiedDate = today;
    }
    updateAccount(info.userId, info.accountId, updates);
    ctx.reply(`自动领券失败（${today}）- 账号：${info.displayName}\n原因：${message}`);
  } finally {
    autoClaimInProgress.delete(taskKey);
  }
}

async function handleMyCoupons(ctx) {
  const info = ensureAccount(ctx);
  if (!info) return;

  try {
    const result = await callToolWithToken(info.account.token, "my-coupons", {});
    const rawText = getToolRawText(result);
    const normalized = normalizeMyCouponsText(rawText);
    const text = formatTelegramHtml(stripImagesFromText(normalized));
    await sendLongMessage(ctx, text || "未返回数据。");
  } catch (error) {
    ctx.reply(`我的优惠券查询失败：${error.message}`);
  }
}

function handleAutoClaimSetting(ctx, enabled, accountId) {
  const info = ensureAccount(ctx, accountId);
  if (!info) return;
  const wasEnabled = Boolean(info.account.autoClaimEnabled);
  updateAccount(info.userId, info.accountId, { autoClaimEnabled: enabled });
  ctx.reply(`账号 ${info.displayName} 自动领券已${enabled ? "开启" : "关闭"}。`);
  if (enabled && !wasEnabled) {
    runImmediateAutoClaim(ctx, info).catch((error) => {
      console.error("Immediate auto-claim failed", error);
    });
  }
}

function handleAutoClaimReportSetting(ctx, type, enabled, accountId) {
  const info = ensureAccount(ctx, accountId);
  if (!info) return;

  const updates = {};
  if (type === "success") {
    updates.autoClaimReportSuccess = enabled;
  } else if (type === "failure") {
    updates.autoClaimReportFailure = enabled;
  } else {
    updates.autoClaimReportSuccess = enabled;
    updates.autoClaimReportFailure = enabled;
  }

  updateAccount(info.userId, info.accountId, updates);

  const label = type === "success" ? "成功汇报" : type === "failure" ? "失败汇报" : "结果汇报";
  ctx.reply(`账号 ${info.displayName} ${label}已${enabled ? "开启" : "关闭"}。`);
}

bot.command("calendar", async (ctx) => {
  const raw = (ctx.message.text || "").split(" ").slice(1).join(" ").trim();
  await handleCalendar(ctx, raw || null);
});

bot.command("coupons", async (ctx) => {
  await handleAvailableCoupons(ctx);
});

bot.command("claim", async (ctx) => {
  await handleClaimCoupons(ctx);
});

bot.command("mycoupons", async (ctx) => {
  await handleMyCoupons(ctx);
});

bot.command("autoclaim", (ctx) => {
  const args = parseCommandArgs(ctx);
  const setting = args[0] ? args[0].toLowerCase() : "";
  const accountId = args[1];
  if (!setting || (setting !== "on" && setting !== "off")) {
    ctx.reply("用法：/autoclaim on|off [账号名]");
    return;
  }

  handleAutoClaimSetting(ctx, setting === "on", accountId);
});

bot.command("autoclaimreport", (ctx) => {
  const args = parseCommandArgs(ctx);
  const first = args[0] ? args[0].toLowerCase() : "";
  const second = args[1] ? args[1].toLowerCase() : "";
  let type = "both";
  let setting = "";
  let accountId = "";

  if (first === "success" || first === "fail" || first === "failure") {
    type = first === "success" ? "success" : "failure";
    setting = second;
    accountId = args[2];
  } else {
    setting = first;
    accountId = args[1];
  }

  if (!setting || (setting !== "on" && setting !== "off")) {
    ctx.reply("用法：/autoclaimreport success|fail on|off [账号名]");
    return;
  }

  handleAutoClaimReportSetting(ctx, type, setting === "on", accountId);
});

bot.action("menu_calendar", async (ctx) => {
  await ctx.answerCbQuery();
  await handleCalendar(ctx, null);
});

bot.action("menu_available", async (ctx) => {
  await ctx.answerCbQuery();
  await handleAvailableCoupons(ctx);
});

bot.action("menu_claim", async (ctx) => {
  await ctx.answerCbQuery();
  await handleClaimCoupons(ctx);
});

bot.action("menu_mycoupons", async (ctx) => {
  await ctx.answerCbQuery();
  await handleMyCoupons(ctx);
});

bot.action("menu_status", async (ctx) => {
  await ctx.answerCbQuery();
  sendStatus(ctx);
});

bot.action("menu_stats", async (ctx) => {
  await ctx.answerCbQuery();
  sendStats(ctx);
});

bot.action("menu_autoclaim_on", async (ctx) => {
  await ctx.answerCbQuery();
  handleAutoClaimSetting(ctx, true);
});

bot.action("menu_autoclaim_off", async (ctx) => {
  await ctx.answerCbQuery();
  handleAutoClaimSetting(ctx, false);
});

bot.action("menu_report_success_on", async (ctx) => {
  await ctx.answerCbQuery();
  handleAutoClaimReportSetting(ctx, "success", true);
});

bot.action("menu_report_success_off", async (ctx) => {
  await ctx.answerCbQuery();
  handleAutoClaimReportSetting(ctx, "success", false);
});

bot.action("menu_report_fail_on", async (ctx) => {
  await ctx.answerCbQuery();
  handleAutoClaimReportSetting(ctx, "failure", true);
});

bot.action("menu_report_fail_off", async (ctx) => {
  await ctx.answerCbQuery();
  handleAutoClaimReportSetting(ctx, "failure", false);
});

bot.action("menu_accounts", async (ctx) => {
  await ctx.answerCbQuery();
  sendAccountHelp(ctx);
});

bot.action("menu_token_help", async (ctx) => {
  await ctx.answerCbQuery();
  sendTokenGuide(ctx);
});

const autoClaimInProgress = new Set();
let autoClaimSweepInProgress = false;

function hashString(input) {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDailyTargetMinute(userId, accountId, today) {
  const startMinutes = AUTO_CLAIM_HOUR * 60;
  const maxWindow = 24 * 60 - startMinutes;
  const windowMinutes = Math.max(1, Math.min(AUTO_CLAIM_SPREAD_MINUTES, maxWindow));
  const seed = `${userId}:${accountId}:${today}`;
  const offset = hashString(seed) % windowMinutes;
  return startMinutes + offset;
}

function shouldRunAutoClaim(userId, accountId, today, nowMinutes) {
  const targetMinute = getDailyTargetMinute(userId, accountId, today);
  return nowMinutes >= targetMinute;
}

function shouldRerunAutoClaim(account) {
  if (!AUTO_CLAIM_SPREAD_RERUN_MINUTES || AUTO_CLAIM_SPREAD_RERUN_MINUTES <= 0) {
    return false;
  }
  const lastRerunAt = account.lastRerunAt || 0;
  if (!lastRerunAt) {
    return true;
  }
  return Date.now() - lastRerunAt >= AUTO_CLAIM_SPREAD_RERUN_MINUTES * 60 * 1000;
}

function getActiveBurst() {
  const state = getGlobalState();
  const burst = state.burst;
  if (!burst || !burst.startAt || !burst.endAt) {
    if (burst) {
      updateGlobalState({ burst: null });
    }
    return null;
  }
  if (Date.now() >= burst.endAt) {
    updateGlobalState({ burst: null });
    return null;
  }
  return burst;
}

function getBurstTargetAt(userId, accountId, burst) {
  const windowMs = Math.max(1, burst.endAt - burst.startAt);
  const seed = `${burst.id}:${userId}:${accountId}`;
  const offsetMs = hashString(seed) % windowMs;
  return burst.startAt + offsetMs;
}

function shouldRunBurst(userId, accountId, burst, nowMs) {
  if (!burst || !burst.startAt || !burst.endAt) {
    return false;
  }
  if (nowMs < burst.startAt || nowMs > burst.endAt) {
    return false;
  }
  const targetAt = getBurstTargetAt(userId, accountId, burst);
  return nowMs >= targetAt;
}

function ensureBurstScheduler(enabled) {
  if (!enabled || !GLOBAL_BURST_CHECK_SECONDS || GLOBAL_BURST_CHECK_SECONDS <= 0) {
    if (burstInterval) {
      clearInterval(burstInterval);
      burstInterval = null;
      logAutoClaim("Burst scheduler stopped.");
    }
    return;
  }
  if (burstInterval) {
    return;
  }
  logAutoClaim(`Burst scheduler started: every ${GLOBAL_BURST_CHECK_SECONDS} seconds.`);
  burstInterval = setInterval(() => {
    runAutoClaimSweep().catch((error) => {
      console.error("Burst auto-claim sweep failed", error);
      notifyAdmins(`Burst 自动领券调度异常：${error.message}`);
    });
  }, GLOBAL_BURST_CHECK_SECONDS * 1000);
}

async function runAutoClaimSweep() {
  if (autoClaimSweepInProgress) {
    logAutoClaimDebug("Sweep skipped: already in progress.");
    return;
  }
  autoClaimSweepInProgress = true;

  const sweepStartedAt = Date.now();
  let sweepEligible = 0;
  let sweepProcessed = 0;
  let sweepReason = "daily";
  let sweepError = "";

  try {
    const users = allUsers();
    const nowMs = Date.now();
    const burst = getActiveBurst();
    ensureBurstScheduler(Boolean(burst));
    sweepReason = burst ? "burst" : "daily";
    const today = getLocalDate(AUTO_CLAIM_TIMEZONE);
    const nowMinutes = getMinutesSinceMidnight(AUTO_CLAIM_TIMEZONE);
    if (!Number.isFinite(nowMinutes)) {
      sweepError = "invalid_time";
      return;
    }

    const tasks = [];
    const skipStats = {
      missingToken: 0,
      autoClaimDisabled: 0,
      burstAlreadyRan: 0,
      burstNotReady: 0,
      dailyAlreadyRan: 0,
      dailyNotDue: 0,
      inProgress: 0
    };
    let nextDailyTarget = null;
    let nextBurstTarget = null;

    logAutoClaimDebug(
      `Sweep start: reason=${sweepReason}, now=${new Date(nowMs).toISOString()}, today=${today}, now=${formatMinutesSinceMidnight(nowMinutes)}`
    );

    for (const [userId, user] of Object.entries(users)) {
      const accounts = user.accounts || {};
      for (const [accountId, account] of Object.entries(accounts)) {
        if (!account || !account.token) {
          skipStats.missingToken += 1;
          continue;
        }
        if (!account.autoClaimEnabled) {
          skipStats.autoClaimDisabled += 1;
          continue;
        }

        let targetMinute = null;
        let targetAt = null;

        if (burst) {
          if (account.lastBurstId === burst.id) {
            skipStats.burstAlreadyRan += 1;
            continue;
          }
          targetAt = getBurstTargetAt(userId, accountId, burst);
          if (nowMs < burst.startAt || nowMs > burst.endAt || nowMs < targetAt) {
            skipStats.burstNotReady += 1;
            if (Number.isFinite(targetAt) && (nextBurstTarget === null || targetAt < nextBurstTarget)) {
              nextBurstTarget = targetAt;
            }
            continue;
          }
        } else {
          const ranToday = account.lastAutoClaimDate === today;
          if (ranToday && !shouldRerunAutoClaim(account)) {
            skipStats.dailyAlreadyRan += 1;
            continue;
          }
          targetMinute = getDailyTargetMinute(userId, accountId, today);
          if (nowMinutes < targetMinute) {
            skipStats.dailyNotDue += 1;
            if (nextDailyTarget === null || targetMinute < nextDailyTarget) {
              nextDailyTarget = targetMinute;
            }
            continue;
          }
        }

        const taskKey = `${userId}:${accountId}`;
        if (autoClaimInProgress.has(taskKey)) {
          skipStats.inProgress += 1;
          continue;
        }

        const displayName = getAccountDisplayName(accountId, account);
        tasks.push({
          userId,
          accountId,
          account,
          displayName,
          reason: burst ? "burst" : "daily",
          targetMinute,
          targetAt
        });
      }
    }

    sweepEligible = tasks.length;
    logAutoClaimDebug(
      `Sweep eligibility: eligible=${sweepEligible}, skipped=${formatSkipStats(skipStats)}, nextDaily=${nextDailyTarget === null ? "n/a" : formatMinutesSinceMidnight(nextDailyTarget)}, nextBurst=${nextBurstTarget === null ? "n/a" : new Date(nextBurstTarget).toISOString()}`
    );
    if (tasks.length === 0) {
      return;
    }

    if (burst) {
      tasks.sort((a, b) => (a.targetAt || 0) - (b.targetAt || 0));
    } else {
      tasks.sort((a, b) => (a.targetMinute || 0) - (b.targetMinute || 0));
    }

    const maxPerSweep = AUTO_CLAIM_MAX_PER_SWEEP > 0 ? AUTO_CLAIM_MAX_PER_SWEEP : tasks.length;
    let remaining = maxPerSweep;
    let nextAllowedAt = getGlobalState().lastAutoClaimRequestAt || 0;

    for (const task of tasks) {
      if (remaining <= 0) {
        break;
      }

      if (AUTO_CLAIM_REQUEST_GAP_MS > 0) {
        const waitMs = nextAllowedAt - Date.now();
        if (waitMs > 0) {
          await sleep(waitMs);
        }
      }

      const taskKey = `${task.userId}:${task.accountId}`;
      autoClaimInProgress.add(taskKey);
      const requestAt = Date.now();
      if (AUTO_CLAIM_REQUEST_GAP_MS > 0) {
        nextAllowedAt = requestAt + AUTO_CLAIM_REQUEST_GAP_MS;
      }
      updateGlobalState({ lastAutoClaimRequestAt: requestAt });

      try {
        const result = await callToolWithToken(task.account.token, "auto-bind-coupons", {});
        const rawText = getToolRawText(result);
        const normalized = normalizeToolText(rawText);
        const simplified = simplifyClaimResultText(normalized);
        const claimed = hasClaimedCoupons(normalized);
        const claimedCount = getClaimedCouponCount(normalized);
        recordClaimedCoupons(normalized, {
          userId: task.userId,
          accountId: task.accountId,
          reason: task.reason
        });
        incrementUserStats(task.userId, { autoClaimRuns: 1, couponsClaimed: claimedCount });

        const message = [
          `自动领券结果（${today}）- 账号：${task.displayName}`,
          "",
          formatTelegramHtml(stripImagesFromText(simplified))
        ].join("\n");

        if (task.account.autoClaimReportSuccess !== false && claimed) {
          await sendLongMessageToUser(task.userId, message);
        }
        logAutoClaimDebug(
          `Auto-claim success: account=${task.displayName}, claimed=${claimed ? claimedCount : 0}`
        );
        updateAccount(task.userId, task.accountId, {
          lastAutoClaimDate: today,
          lastAutoClaimAt: getLocalDateTime(AUTO_CLAIM_TIMEZONE),
          lastAutoClaimStatus: "成功",
          lastBurstId: task.reason === "burst" ? burst.id : task.account.lastBurstId,
          lastRerunAt: Date.now()
        });
      } catch (error) {
        const authFailure = isAuthFailureMessage(error && error.message ? error.message : "");
        const shouldNotifyAuthFailure =
          authFailure && task.account.lastAuthFailureNotifiedDate !== today;
        const accountUpdates = {
          lastAutoClaimDate: today,
          lastAutoClaimAt: getLocalDateTime(AUTO_CLAIM_TIMEZONE),
          lastAutoClaimStatus: `失败：${error.message}`,
          lastBurstId: task.reason === "burst" ? burst.id : task.account.lastBurstId,
          lastRerunAt: Date.now()
        };
        if (shouldNotifyAuthFailure) {
          accountUpdates.lastAuthFailureNotifiedDate = today;
        }
        updateAccount(task.userId, task.accountId, {
          ...accountUpdates
        });

        sweepError = error.message || sweepError;
        logAutoClaim(`Auto-claim failed: account=${task.displayName}, error=${error.message}`);
        await notifyAdmins(
          `自动领券失败（${today}）- Token：${task.account.token}\n原因：${error.message}`
        );

        if (authFailure) {
          if (shouldNotifyAuthFailure) {
            try {
              await sendLongMessageToUser(
                task.userId,
                [
                  `自动领券失败（${today}）- 账号：${task.displayName}`,
                  "原因：鉴权失败，Token 已失效，请更新 Token。",
                  "可使用 /token 或 /account add 重新设置。"
                ].join("\n")
              );
            } catch (sendError) {
              console.error("Failed to send auth-failure notice to user", sendError);
            }
          }
        } else if (task.account.autoClaimReportFailure !== false) {
          try {
            await sendLongMessageToUser(
              task.userId,
              `自动领券失败（${today}）- 账号：${task.displayName}\n${error.message}`
            );
          } catch (sendError) {
            console.error("Failed to send auto-claim error to user", sendError);
          }
        }
      } finally {
        autoClaimInProgress.delete(taskKey);
        remaining -= 1;
        sweepProcessed += 1;
      }
    }
  } catch (error) {
    sweepError = error && error.message ? error.message : "未知错误";
    throw error;
  } finally {
    const finishedAt = Date.now();
    updateGlobalState({
      lastSweepStartedAt: sweepStartedAt,
      lastSweepFinishedAt: finishedAt,
      lastSweepDurationMs: finishedAt - sweepStartedAt,
      lastSweepEligible: sweepEligible,
      lastSweepProcessed: sweepProcessed,
      lastSweepReason: sweepReason,
      lastSweepError: sweepError
    });
    autoClaimSweepInProgress = false;
    logAutoClaim(
      `Sweep finished: reason=${sweepReason}, eligible=${sweepEligible}, processed=${sweepProcessed}, durationMs=${finishedAt - sweepStartedAt}, error=${sweepError || "none"}`
    );
  }
}

function startAutoClaimScheduler() {
  if (!AUTO_CLAIM_CHECK_MINUTES || AUTO_CLAIM_CHECK_MINUTES <= 0) {
    logAutoClaim("Scheduler disabled: AUTO_CLAIM_CHECK_MINUTES <= 0.");
    return;
  }
  logAutoClaim(`Scheduler started: every ${AUTO_CLAIM_CHECK_MINUTES} minutes.`);
  const trigger = () => {
    logAutoClaimDebug("Scheduler trigger fired.");
    runAutoClaimSweep().catch((error) => {
      console.error("Auto-claim sweep failed", error);
      notifyAdmins(`自动领券调度异常：${error.message}`);
    });
  };
  trigger();
  autoClaimInterval = setInterval(trigger, AUTO_CLAIM_CHECK_MINUTES * 60 * 1000);
}

function startSweepWatchdog() {
  if (!SWEEP_WATCHDOG_SECONDS || SWEEP_WATCHDOG_SECONDS <= 0) {
    logAutoClaim("Sweep watchdog disabled: SWEEP_WATCHDOG_SECONDS <= 0.");
    return;
  }
  logAutoClaim(`Sweep watchdog started: every ${SWEEP_WATCHDOG_SECONDS} seconds.`);
  const check = () => {
    const today = getLocalDate(AUTO_CLAIM_TIMEZONE);
    getAdminSummaryBaseline(today);
    const state = getGlobalState();
    const lastFinished = state.lastSweepFinishedAt || state.lastSweepStartedAt || 0;
    const staleAfterMs =
      Math.max(AUTO_CLAIM_CHECK_MINUTES || 1, 1) * 60 * 1000 * Math.max(SWEEP_STALE_MULTIPLIER || 1, 1);
    const now = Date.now();
    const isStale = !autoClaimSweepInProgress && now - lastFinished > staleAfterMs;
    if (isStale) {
      console.warn("Sweep watchdog: detected stale scheduler, triggering sweep now.");
      logAutoClaim("Sweep watchdog triggered: scheduler stale, running sweep.");
      runAutoClaimSweep().catch((error) => {
        console.error("Sweep watchdog failed to trigger sweep", error);
        notifyAdmins(`Sweep watchdog异常：${error.message}`);
      });
    }
  };
  check();
  watchdogInterval = setInterval(check, SWEEP_WATCHDOG_SECONDS * 1000);
}

startAutoClaimScheduler();
startSweepWatchdog();

bot.launch()
  .then(() => {
    console.log("Bot started.");
    bot.telegram.setMyCommands([
      { command: "menu", description: "打开按钮菜单" },
      { command: "token", description: "设置 MCP Token（默认账号）" },
      { command: "account", description: "账号管理" },
      { command: "calendar", description: "活动日历查询" },
      { command: "coupons", description: "可领优惠券列表" },
      { command: "claim", description: "一键领券" },
      { command: "mycoupons", description: "我的优惠券" },
      { command: "autoclaim", description: "每日自动领券开关" },
      { command: "autoclaimreport", description: "自动领券汇报开关(成/败)" },
      { command: "status", description: "查看账号状态" },
      { command: "stats", description: "查看我的领券统计" },
      { command: "cleartoken", description: "清空全部账号" },
      { command: "admin", description: "管理员统计" }
    ]).catch((error) => {
      console.error("Failed to set bot commands", error);
    });
  })
  .catch((error) => {
    console.error("Bot failed to start.", error);
    process.exit(1);
  });

function shutdown(signal) {
  if (autoClaimInterval) {
    clearInterval(autoClaimInterval);
    autoClaimInterval = null;
  }
  if (burstInterval) {
    clearInterval(burstInterval);
    burstInterval = null;
  }
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
  }
  bot.stop(signal);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
