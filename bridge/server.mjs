import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { BridgeError, DEFAULT_MODEL } from "./codex-client.mjs";

export function validateRequest(body) {
  if (
    !body ||
    typeof body !== "object" ||
    !Array.isArray(body.messages) ||
    body.messages.length < 1 ||
    body.messages.length > 20
  )
    throw new BridgeError(
      "Provide 1–20 text messages.",
      400,
      "invalid_request",
    );
  for (const message of body.messages) {
    if (
      !message ||
      !["system", "user", "assistant"].includes(message.role) ||
      typeof message.content !== "string"
    )
      throw new BridgeError(
        "Only text chat messages are supported.",
        400,
        "invalid_request",
      );
  }
  if (!body.messages.some((m) => m.role === "user" && m.content.trim()))
    throw new BridgeError("Source text is empty.", 400, "invalid_request");
  if (body.messages.reduce((n, m) => n + m.content.length, 0) > 50000)
    throw new BridgeError(
      "Select a shorter passage (maximum 50,000 characters).",
      413,
      "too_large",
    );
  if (body.stream !== undefined && typeof body.stream !== "boolean")
    throw new BridgeError("stream must be a boolean.", 400, "invalid_request");
  if (
    body.model !== undefined &&
    (typeof body.model !== "string" || body.model.length > 120)
  )
    throw new BridgeError("Invalid model name.", 400, "invalid_model");
  if (body.tools || body.functions)
    throw new BridgeError(
      "Tools are not supported by the translation bridge.",
      400,
      "invalid_request",
    );
  return {
    messages: body.messages.map(({ role, content }) => ({ role, content })),
    model: body.model || DEFAULT_MODEL,
    stream: body.stream === true,
  };
}

class TranslationQueue {
  constructor(limit) {
    this.limit = limit;
    this.active = false;
    this.waiting = [];
  }
  acquire(signal) {
    signal.throwIfAborted();
    if (!this.active) {
      this.active = true;
      return Promise.resolve();
    }
    if (this.waiting.length >= this.limit)
      return Promise.reject(
        new BridgeError(
          "Translation queue is full. Retry shortly.",
          429,
          "busy",
        ),
      );
    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        signal,
        abort: () => {
          this.waiting = this.waiting.filter((job) => job !== entry);
          reject(signal.reason);
        },
      };
      signal.addEventListener("abort", entry.abort, { once: true });
      this.waiting.push(entry);
    });
  }
  release() {
    const next = this.waiting.shift();
    if (next) {
      next.signal.removeEventListener("abort", next.abort);
      next.resolve();
    } else this.active = false;
  }
}

function authorized(header, token) {
  const actual = Buffer.from(header || "");
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function json(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024)
      throw new BridgeError("Request too large.", 413, "too_large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BridgeError("Invalid JSON body.", 400, "invalid_request");
  }
}

export function createBridgeServer({
  translator,
  token,
  origins = [],
  queueLimit = 4,
  requestTimeoutMs = 120000,
}) {
  if (typeof token !== "string" || token.length < 24)
    throw new Error(
      "A local bridge token of at least 24 characters is required.",
    );
  const queue = new TranslationQueue(queueLimit);
  const controllers = new Set();
  const server = createServer(async (req, res) => {
    let controller;
    let acquired = false;
    let timer;
    let heartbeat;
    try {
      const host = req.headers.host || "";
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host))
        throw new BridgeError("Loopback Host required.", 403, "forbidden");
      const origin = req.headers.origin;
      if (origin && !origins.includes(origin))
        throw new BridgeError("Origin is not allowed.", 403, "forbidden");
      if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      }
      if (req.method === "OPTIONS" && origin) {
        res.writeHead(204, {
          "Access-Control-Allow-Methods": "POST, GET",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
        });
        res.end();
        return;
      }
      if (req.url === "/health" && req.method === "GET") {
        const ready = !translator.rpc?.closed;
        json(res, ready ? 200 : 503, {
          status: ready ? "ok" : "codex_disconnected",
          service: "zotero-codex-translate",
        });
        return;
      }
      if (!authorized(req.headers.authorization, token))
        throw new BridgeError(
          "Invalid local bridge token. Copy it from the bridge setup into Zotero settings.",
          401,
          "unauthorized",
        );
      if (req.url === "/v1/models" && req.method === "GET") {
        json(res, 200, {
          object: "list",
          data: [
            { id: "codex-auto", object: "model", owned_by: "codex" },
            ...translator.models.map((m) => ({
              id: m.model,
              object: "model",
              owned_by: "openai",
            })),
          ],
        });
        return;
      }
      if (req.url !== "/v1/chat/completions" || req.method !== "POST")
        throw new BridgeError(
          "Use POST /v1/chat/completions.",
          404,
          "not_found",
        );
      if (
        !req.headers["content-type"]
          ?.toLowerCase()
          .startsWith("application/json")
      )
        throw new BridgeError(
          "Content-Type must be application/json.",
          415,
          "invalid_request",
        );
      const request = validateRequest(await readJson(req));
      translator.chooseModel(request.model);
      controller = new AbortController();
      controllers.add(controller);
      res.on("close", () => {
        if (!res.writableEnded)
          controller.abort(
            new BridgeError("Client disconnected.", 499, "cancelled"),
          );
      });
      timer = setTimeout(
        () =>
          controller.abort(
            new BridgeError(
              "Translation timed out. Select a shorter passage and retry.",
              504,
              "timeout",
            ),
          ),
        requestTimeoutMs,
      );
      await queue.acquire(controller.signal);
      acquired = true;
      controller.signal.throwIfAborted();
      const id = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      const model = translator.chooseModel(request.model).model;
      const chunk = (delta, finish_reason = null) => ({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason }],
      });
      const sse = (value) => {
        if (!res.destroyed) res.write(`data: ${JSON.stringify(value)}\n\n`);
      };
      if (request.stream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-store",
          Connection: "keep-alive",
          "X-Content-Type-Options": "nosniff",
        });
        sse(chunk({ role: "assistant", content: "" }));
        heartbeat = setInterval(() => {
          if (!res.destroyed) res.write(": keepalive\n\n");
        }, 10000);
      }
      const result = await translator.translate({
        ...request,
        signal: controller.signal,
        onDelta: request.stream
          ? (content) => sse(chunk({ content }))
          : undefined,
      });
      controller.signal.throwIfAborted();
      if (request.stream) {
        sse(chunk({}, "stop"));
        res.end("data: [DONE]\n\n");
      } else
        json(res, 200, {
          id,
          object: "chat.completion",
          created,
          model: result.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: result.text },
              finish_reason: "stop",
            },
          ],
        });
    } catch (error) {
      const actual = controller?.signal.aborted
        ? controller.signal.reason
        : error;
      const payload = {
        error: {
          message:
            actual instanceof BridgeError
              ? actual.message
              : "Translation failed. Check the bridge and retry.",
          type: "bridge_error",
          code: actual?.code || "internal_error",
        },
      };
      if (!res.destroyed) {
        if (res.headersSent)
          res.end(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`);
        else json(res, actual?.status || 500, payload);
      }
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
      if (controller) controllers.delete(controller);
      if (acquired) queue.release();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.on("close", () => {
    for (const c of controllers)
      c.abort(new BridgeError("Bridge stopped.", 503));
  });
  server.stop = async () => {
    for (const c of controllers)
      c.abort(new BridgeError("Bridge stopped.", 503));
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  };
  return server;
}
