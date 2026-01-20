# MaiMai Telegram Bot

A Telegram bot that calls the McDonald's MCP tools (campaign calendar and coupons) via Streamable HTTP.

## Features

- Campaign calendar query (`campaign-calender`) via Telegraph article (with images)
- Available coupons list (`available-coupons`) via Telegraph article (with images)
- One-click claim all coupons (`auto-bind-coupons`)
- My coupons list (`my-coupons`)
- Optional 5-minute cache for non-user-specific tools
- Daily auto-claim (once per day) with burst scheduling when new coupons appear
- Multiple MCP accounts per Telegram user (switchable)

## Requirements

- Node.js 18+ (Node.js 20+ recommended)
- A Telegram bot token from BotFather
- An MCP token from https://open.mcd.cn/mcp

## Quick Start

1. Copy `.env.example` to `.env` and fill in `TELEGRAM_BOT_TOKEN`.
2. Install dependencies:

```bash
npm install
```

3. Start the bot:

```bash
npm start
```

## Bot Commands

- `/token YOUR_MCP_TOKEN` - save your MCP token
- `/account add <name> <token>` - add/update an account
- `/account use <name>` - switch active account
- `/account list` - list accounts
- `/account del <name>` - delete an account
- `/calendar [YYYY-MM-DD]` - campaign calendar (optional date)
- `/coupons` - available coupons
- `/claim` - one-click claim all available coupons
- `/mycoupons` - my coupons list
- `/autoclaim on|off [name]` - enable/disable daily auto-claim per account
- `/autoclaimreport success|fail on|off [name]` - enable/disable auto-claim reporting per account
- `/status` - show account status
- `/stats` - my claim stats
- `/cleartoken` - clear all accounts
- `/admin` - admin summary (users/accounts/auto-claim status/claim totals/config/sweep状态)
- `/admin notify on|off` - admin error push toggle
- `/admin sweep` - run a sweep immediately (admin)

## Environment Variables

See `.env.example` for all options. Key variables:

- `MCD_MCP_URL` (default: `https://mcp.mcd.cn/mcp-servers/mcd-mcp`)
- `MCP_REQUEST_TIMEOUT_MS` (default: `30000`)
- `MCP_CLIENT_CACHE_TTL_SECONDS` (default: `1800`)
- `MCP_RETRY_MAX` (default: `2`)
- `MCP_RETRY_BASE_DELAY_MS` (default: `500`)
- `MCP_RETRY_MAX_DELAY_MS` (default: `5000`)
- `MCP_RETRY_JITTER_MS` (default: `200`)
- `MCP_RETRY_STATUS_CODES` (default: `502,503,504`)
- `MCP_RETRY_ON_TIMEOUT` (default: `true`)
- `MCP_RETRY_ON_NETWORK_ERROR` (default: `true`)
- `MCP_HEALTH_CHECK_INTERVAL_MS` (default: `60000`)
- `MCP_HEALTH_CHECK_TIMEOUT_MS` (default: `5000`)
- `MCP_HEALTH_FAILURE_THRESHOLD` (default: `2`)
- `MCP_UPSTREAM_ERROR_MESSAGE` (default: Chinese "upstream error")
- `ACCOUNT_ID_MIN_LENGTH` (default: `1`)
- `ACCOUNT_ID_MAX_LENGTH` (default: `32`)
- `TOKEN_MIN_LENGTH` (default: `16`)
- `TOKEN_MAX_LENGTH` (default: `256`)
- `TOKEN_SET_RATE_LIMIT_MS` (default: `30000`)
- `ACCOUNT_SET_RATE_LIMIT_MS` (default: `30000`)
- `CACHE_TTL_SECONDS` (default: `300`)
- `CACHEABLE_TOOLS` (default: `campaign-calender,available-coupons`)
- `AUTO_CLAIM_CHECK_MINUTES` (default: `10`)
- `AUTO_CLAIM_HOUR` (default: `9`)
- `AUTO_CLAIM_TIMEZONE` (default: `Asia/Shanghai`)
- `AUTO_CLAIM_SPREAD_MINUTES` (default: `600`)
- `AUTO_CLAIM_MAX_PER_SWEEP` (default: `10`)
- `AUTO_CLAIM_REQUEST_GAP_MS` (default: `1500`)
- `AUTO_CLAIM_SPREAD_RERUN_MINUTES` (default: `120`)
- `GLOBAL_BURST_WINDOW_MINUTES` (default: `30`)
- `GLOBAL_BURST_CHECK_SECONDS` (default: `60`)
- `ADMIN_TELEGRAM_IDS` (comma-separated Telegram user IDs)
- `SWEEP_WATCHDOG_SECONDS` (default: `60`)
- `SWEEP_STALE_MULTIPLIER` (default: `2`)
- `AUTO_CLAIM_DEBUG` (default: `false`, set to `true`/`1` to enable verbose auto-claim logs)

## Notes

- The bot uses MCP Streamable HTTP (protocol 2025-06-18).
- The MCP token is required for all tool calls.
- Telegraph access token is created automatically and stored at `data/telegraph.json`.
- Auto-claim runs once per account per day, scheduled across a spread window to avoid bursts.
- When any account claims a previously unseen coupon, the bot triggers a short burst window so all accounts attempt to claim within that time.

## Deployment

### 1) Install Node.js

```bash
sudo apt update
sudo apt install -y git curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

Verify:

```bash
node -v
npm -v
```

### 2) Install the bot

```bash
git clone https://github.com/ButaiKirin/MaiMaiBot.git
cd MaiMaiBot
cp .env.example .env
```

Edit `.env` and set:

- `TELEGRAM_BOT_TOKEN`
- `MCD_MCP_URL` (optional)

Install dependencies:

```bash
npm install
```

Run once to verify:

```bash
npm start
```

### 3) Run as a systemd service

Create a service file:

```bash
sudo tee /etc/systemd/system/maimai-bot.service > /dev/null <<'SERVICE'
[Unit]
Description=MaiMai Telegram Bot
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/MaiMaiBot
EnvironmentFile=/opt/MaiMaiBot/.env
ExecStart=/usr/bin/node /opt/MaiMaiBot/src/index.js
Restart=always
RestartSec=5
User=ubuntu
Group=ubuntu

[Install]
WantedBy=multi-user.target
SERVICE
```

Adjust paths and user:

```bash
sudo mkdir -p /opt
sudo mv ~/MaiMaiBot /opt/MaiMaiBot
sudo chown -R ubuntu:ubuntu /opt/MaiMaiBot
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now maimai-bot
```

View logs:

```bash
journalctl -u maimai-bot -f
```

### 4) Update

```bash
cd /opt/MaiMaiBot
git pull
npm install
sudo systemctl restart maimai-bot
```
