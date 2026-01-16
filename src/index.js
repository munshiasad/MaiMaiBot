require("dotenv").config();

const { Telegraf } = require("telegraf");
const { MCPClient } = require("./mcpClient");
const { TTLCache } = require("./cache");
const { getUser, upsertUser, deleteUser, allUsers } = require("./storage");
const { getLocalDate, getLocalHour, getLocalDateTime } = require("./time");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN in environment.");
  process.exit(1);
}

const MCP_URL = process.env.MCD_MCP_URL || "https://mcp.mcd.cn/mcp-servers/mcd-mcp";
const MCP_PROTOCOL_VERSION = process.env.MCP_PROTOCOL_VERSION || "2025-06-18";

const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 300);
const CACHEABLE_TOOLS = new Set(
  (process.env.CACHEABLE_TOOLS || "campaign-calender,now-time-info")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);

const AUTO_CLAIM_CHECK_MINUTES = Number(process.env.AUTO_CLAIM_CHECK_MINUTES || 10);
const AUTO_CLAIM_HOUR = Number(process.env.AUTO_CLAIM_HOUR || 9);
const AUTO_CLAIM_TIMEZONE = process.env.AUTO_CLAIM_TIMEZONE || "Asia/Shanghai";

const cache = new TTLCache(CACHE_TTL_SECONDS * 1000);
const bot = new Telegraf(BOT_TOKEN);
let autoClaimInterval = null;

function chunkText(text, maxLength = 3500) {
  const chunks = [];
  for (let i = 0; i < text.length; i += maxLength) {
    chunks.push(text.slice(i, i + maxLength));
  }
  return chunks;
}

async function sendLongMessage(ctx, text) {
  const chunks = chunkText(text);
  for (const chunk of chunks) {
    await ctx.reply(chunk, { disable_web_page_preview: true });
  }
}

async function sendLongMessageToUser(userId, text) {
  const chunks = chunkText(text);
  for (const chunk of chunks) {
    await bot.telegram.sendMessage(userId, chunk, { disable_web_page_preview: true });
  }
}

function formatToolResult(result) {
  if (typeof result === "string") {
    return result;
  }

  if (result && Array.isArray(result.content)) {
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
          parts.push("[image content omitted]");
        }
      }
    }
    const text = parts.join("\n\n").trim();
    if (text) {
      return text;
    }
  }

  try {
    return JSON.stringify(result, null, 2);
  } catch (error) {
    return String(result);
  }
}

function ensureToken(ctx) {
  const userId = String(ctx.from.id);
  const user = getUser(userId);
  if (!user || !user.token) {
    ctx.reply("Please set your MCP token first with /token <YOUR_TOKEN>.");
    return null;
  }
  return user;
}

async function callToolForUser(userId, toolName, args) {
  const user = getUser(userId);
  if (!user || !user.token) {
    throw new Error("Missing MCP token. Use /token to set it.");
  }

  const cacheKey = `${toolName}:${JSON.stringify(args || {})}`;
  const useCache = CACHEABLE_TOOLS.has(toolName);
  if (useCache) {
    const cached = cache.get(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const client = new MCPClient({
    baseUrl: MCP_URL,
    token: user.token,
    protocolVersion: MCP_PROTOCOL_VERSION
  });

  const result = await client.callTool(toolName, args || {});
  if (useCache) {
    cache.set(cacheKey, result);
  }
  return result;
}

bot.catch((error, ctx) => {
  console.error("Bot error", error);
  if (ctx && ctx.reply) {
    ctx.reply("Something went wrong. Please try again later.");
  }
});

bot.start((ctx) => {
  const message = [
    "Welcome. Set your MCP token with:",
    "/token YOUR_MCP_TOKEN",
    "",
    "Commands:",
    "/calendar [YYYY-MM-DD] - Campaign calendar",
    "/coupons - Available coupons",
    "/claim - One-click claim all coupons",
    "/mycoupons - My coupons",
    "/time - Current time info",
    "/autoclaim on|off - Daily auto-claim",
    "/status - View token/auto-claim status",
    "/cleartoken - Remove your token"
  ].join("\n");
  ctx.reply(message, { disable_web_page_preview: true });
});

bot.command(["token", "settoken"], (ctx) => {
  const text = ctx.message.text || "";
  const token = text.split(" ").slice(1).join(" ").trim();
  if (!token) {
    ctx.reply("Usage: /token YOUR_MCP_TOKEN");
    return;
  }
  const userId = String(ctx.from.id);
  upsertUser(userId, { token });
  ctx.reply("Token saved. You can now use the bot commands.");
});

bot.command("cleartoken", (ctx) => {
  const userId = String(ctx.from.id);
  const existing = getUser(userId);
  if (!existing) {
    ctx.reply("No token stored.");
    return;
  }
  deleteUser(userId);
  ctx.reply("Token removed.");
});

bot.command("status", (ctx) => {
  const userId = String(ctx.from.id);
  const user = getUser(userId);
  if (!user) {
    ctx.reply("No token stored. Use /token to set it.");
    return;
  }
  const autoClaimStatus = user.autoClaimEnabled ? "enabled" : "disabled";
  const lastRun = user.lastAutoClaimAt || "never";
  ctx.reply(
    `Token: ${user.token ? "set" : "missing"}\nAuto-claim: ${autoClaimStatus}\nLast auto-claim: ${lastRun}`
  );
});

bot.command("calendar", async (ctx) => {
  const user = ensureToken(ctx);
  if (!user) return;

  const raw = (ctx.message.text || "").split(" ").slice(1).join(" ").trim();
  let args = {};
  if (raw) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      ctx.reply("Invalid date format. Use YYYY-MM-DD.");
      return;
    }
    args = { specifiedDate: raw };
  }

  try {
    const result = await callToolForUser(String(ctx.from.id), "campaign-calender", args);
    const text = formatToolResult(result);
    await sendLongMessage(ctx, text || "No data returned.");
  } catch (error) {
    ctx.reply(`Calendar request failed: ${error.message}`);
  }
});

bot.command("coupons", async (ctx) => {
  const user = ensureToken(ctx);
  if (!user) return;

  try {
    const result = await callToolForUser(String(ctx.from.id), "available-coupons", {});
    const text = formatToolResult(result);
    await sendLongMessage(ctx, text || "No data returned.");
  } catch (error) {
    ctx.reply(`Coupons request failed: ${error.message}`);
  }
});

bot.command("claim", async (ctx) => {
  const user = ensureToken(ctx);
  if (!user) return;

  try {
    const result = await callToolForUser(String(ctx.from.id), "auto-bind-coupons", {});
    const text = formatToolResult(result);
    await sendLongMessage(ctx, text || "No data returned.");
  } catch (error) {
    ctx.reply(`Claim request failed: ${error.message}`);
  }
});

bot.command("mycoupons", async (ctx) => {
  const user = ensureToken(ctx);
  if (!user) return;

  try {
    const result = await callToolForUser(String(ctx.from.id), "my-coupons", {});
    const text = formatToolResult(result);
    await sendLongMessage(ctx, text || "No data returned.");
  } catch (error) {
    ctx.reply(`My coupons request failed: ${error.message}`);
  }
});

bot.command("time", async (ctx) => {
  const user = ensureToken(ctx);
  if (!user) return;

  try {
    const result = await callToolForUser(String(ctx.from.id), "now-time-info", {});
    const text = formatToolResult(result);
    await sendLongMessage(ctx, text || "No data returned.");
  } catch (error) {
    ctx.reply(`Time request failed: ${error.message}`);
  }
});

bot.command("autoclaim", (ctx) => {
  const userId = String(ctx.from.id);
  const user = getUser(userId);
  if (!user || !user.token) {
    ctx.reply("Please set your MCP token first with /token <YOUR_TOKEN>.");
    return;
  }

  const text = ctx.message.text || "";
  const arg = text.split(" ").slice(1).join(" ").trim().toLowerCase();
  if (!arg || (arg !== "on" && arg !== "off")) {
    ctx.reply("Usage: /autoclaim on|off");
    return;
  }

  const enabled = arg === "on";
  upsertUser(userId, { autoClaimEnabled: enabled });
  ctx.reply(`Auto-claim ${enabled ? "enabled" : "disabled"}.`);
});

const autoClaimInProgress = new Set();

async function runAutoClaimSweep() {
  const users = allUsers();
  const today = getLocalDate(AUTO_CLAIM_TIMEZONE);
  const currentHour = getLocalHour(AUTO_CLAIM_TIMEZONE);

  if (Number.isNaN(currentHour) || currentHour < AUTO_CLAIM_HOUR) {
    return;
  }

  for (const [userId, user] of Object.entries(users)) {
    if (!user.autoClaimEnabled || !user.token) {
      continue;
    }
    if (user.lastAutoClaimDate === today) {
      continue;
    }
    if (autoClaimInProgress.has(userId)) {
      continue;
    }

    autoClaimInProgress.add(userId);
    try {
      const result = await callToolForUser(userId, "auto-bind-coupons", {});
      const message = [
        `Auto-claim result (${today}):`,
        "",
        formatToolResult(result)
      ].join("\n");

      await sendLongMessageToUser(userId, message);
      upsertUser(userId, {
        lastAutoClaimDate: today,
        lastAutoClaimAt: getLocalDateTime(AUTO_CLAIM_TIMEZONE),
        lastAutoClaimStatus: "success"
      });
    } catch (error) {
      upsertUser(userId, {
        lastAutoClaimDate: today,
        lastAutoClaimAt: getLocalDateTime(AUTO_CLAIM_TIMEZONE),
        lastAutoClaimStatus: `error: ${error.message}`
      });

      try {
        await sendLongMessageToUser(
          userId,
          `Auto-claim failed (${today}): ${error.message}`
        );
      } catch (sendError) {
        console.error("Failed to send auto-claim error to user", sendError);
      }
    } finally {
      autoClaimInProgress.delete(userId);
    }
  }
}

function startAutoClaimScheduler() {
  if (!AUTO_CLAIM_CHECK_MINUTES || AUTO_CLAIM_CHECK_MINUTES <= 0) {
    return;
  }
  autoClaimInterval = setInterval(() => {
    runAutoClaimSweep().catch((error) => {
      console.error("Auto-claim sweep failed", error);
    });
  }, AUTO_CLAIM_CHECK_MINUTES * 60 * 1000);
}

bot.launch()
  .then(() => {
    console.log("Bot started.");
    runAutoClaimSweep().catch((error) => {
      console.error("Initial auto-claim sweep failed", error);
    });
    startAutoClaimScheduler();
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
  bot.stop(signal);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
