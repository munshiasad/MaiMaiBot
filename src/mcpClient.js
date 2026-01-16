const DEFAULT_ACCEPT = "application/json, text/event-stream";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

class MCPClient {
  constructor({ baseUrl, token, protocolVersion = DEFAULT_PROTOCOL_VERSION, clientInfo }) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.protocolVersion = protocolVersion;
    this.clientInfo = clientInfo || {
      name: "MaiMaiTelegramBot",
      title: "MaiMai Telegram Bot",
      version: "1.0.0"
    };
    this.sessionId = null;
    this.initialized = false;
    this.nextRequestId = 1;
  }

  async callTool(name, args) {
    await this.initialize();
    const message = {
      jsonrpc: "2.0",
      id: this._nextId(),
      method: "tools/call",
      params: {
        name,
        arguments: args || {}
      }
    };

    try {
      const response = await this._sendRpc(message, { expectResponse: true });
      return this._unwrapResult(response);
    } catch (error) {
      if (error && error.code === "MCP_SESSION_EXPIRED") {
        this.initialized = false;
        this.sessionId = null;
        await this.initialize();
        const retryResponse = await this._sendRpc(message, { expectResponse: true });
        return this._unwrapResult(retryResponse);
      }
      throw error;
    }
  }

  async initialize() {
    if (this.initialized) {
      return;
    }

    const initMessage = {
      jsonrpc: "2.0",
      id: this._nextId(),
      method: "initialize",
      params: {
        protocolVersion: this.protocolVersion,
        capabilities: {},
        clientInfo: this.clientInfo
      }
    };

    const response = await this._sendRpc(initMessage, {
      expectResponse: true
    });

    if (!response || response.error) {
      const message = response && response.error && response.error.message
        ? response.error.message
        : "Failed to initialize MCP session";
      throw new Error(message);
    }

    if (response.result && response.result.protocolVersion) {
      this.protocolVersion = response.result.protocolVersion;
    }

    const initializedNotification = {
      jsonrpc: "2.0",
      method: "notifications/initialized"
    };

    await this._sendRpc(initializedNotification, { expectResponse: false });
    this.initialized = true;
  }

  _nextId() {
    return this.nextRequestId++;
  }

  async _sendRpc(message, options = {}) {
    const expectResponse = options.expectResponse ?? !!message.id;
    const headers = {
      Accept: DEFAULT_ACCEPT,
      "Content-Type": "application/json"
    };

    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }

    if (options.includeProtocolHeader !== false && this.protocolVersion) {
      headers["MCP-Protocol-Version"] = this.protocolVersion;
    }

    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(message)
    });

    if (!expectResponse) {
      if (![200, 202, 204].includes(response.status)) {
        const body = await safeReadText(response);
        throw new Error(`MCP notification rejected (${response.status}): ${body}`);
      }
      return null;
    }

    if (response.status === 404 && this.sessionId) {
      const error = new Error("MCP session expired");
      error.code = "MCP_SESSION_EXPIRED";
      throw error;
    }

    if (!response.ok) {
      const body = await safeReadText(response);
      throw new Error(`MCP request failed (${response.status}): ${body}`);
    }

    const newSessionId = response.headers.get("mcp-session-id");
    if (newSessionId && !this.sessionId) {
      this.sessionId = newSessionId;
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream")) {
      const text = await response.text();
      return parseSseForResponse(text, message.id);
    }

    return response.json();
  }

  _unwrapResult(response) {
    if (!response) {
      throw new Error("Empty MCP response");
    }
    if (response.error) {
      throw new Error(response.error.message || "MCP error");
    }
    return response.result ?? response;
  }
}

function parseSseForResponse(text, requestId) {
  const events = [];
  let dataLines = [];
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    } else if (line.trim() === "") {
      if (dataLines.length) {
        events.push(dataLines.join("\n"));
        dataLines = [];
      }
    }
  }

  if (dataLines.length) {
    events.push(dataLines.join("\n"));
  }

  let lastEvent = null;
  for (const payload of events) {
    try {
      const parsed = JSON.parse(payload);
      lastEvent = parsed;
      if (requestId !== undefined && parsed.id === requestId) {
        return parsed;
      }
    } catch (error) {
      continue;
    }
  }

  if (lastEvent) {
    return lastEvent;
  }

  throw new Error("No JSON-RPC response found in SSE stream");
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch (error) {
    return "";
  }
}

module.exports = {
  MCPClient
};
