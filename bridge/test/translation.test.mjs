import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { request as httpRequest } from "node:http";
import { build } from "esbuild";
import { CodexTranslator, RpcClient, BridgeError } from "../codex-client.mjs";
import { createBridgeServer } from "../server.mjs";

const compiled = await build({
  entryPoints: ["src/modules/services/codexProtocol.ts"],
  bundle: true,
  format: "esm",
  write: false,
});
const { CodexStreamParser, validateCodexEndpoint, parseCodexResponse } =
  await import(
    `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
  );
const token = "test-local-token-with-at-least-24-characters";

test("SSE parser tolerates every byte boundary and multiline content", () => {
  const content = "相关不代表因果。\n95% CI: 1.2–1.5";
  const stream =
    ": keepalive\r\n\r\ndata: " +
    JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] }) +
    "\r\n\r\ndata: " +
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
    "\n\ndata: [DONE]\n\n";
  for (let split = 0; split <= stream.length; split++) {
    const parser = new CodexStreamParser();
    parser.feed(stream.slice(0, split));
    parser.feed(stream.slice(split));
    assert.equal(parser.finish(), content);
  }
  const parser = new CodexStreamParser();
  for (const char of stream) parser.feed(char);
  assert.equal(parser.finish(), content);
});

test("partial output, malformed packets, and streamed errors cannot become successful translations", () => {
  const parser = new CodexStreamParser();
  parser.feed('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  assert.throws(() => parser.finish(), /interrupted/);
  assert.throws(
    () => parser.feed('data: {"error":{"message":"Quota exceeded"}}\n\n'),
    /Quota/,
  );
  assert.throws(() => new CodexStreamParser().feed("data: broken\n\n"));
  assert.throws(
    () =>
      parseCodexResponse(
        '{"choices":[{"message":{"content":"partial"},"finish_reason":"length"}]}',
      ),
    /interrupted/,
  );
});

test("plugin rejects remote URLs and credentials in endpoint", () => {
  assert.equal(
    validateCodexEndpoint("http://127.0.0.1:18765/v1/chat/completions"),
    "http://127.0.0.1:18765/v1/chat/completions",
  );
  for (const value of [
    "https://api.openai.com/v1/chat/completions",
    "http://127.0.0.1.evil.test/v1/chat/completions",
    "http://user:password@localhost/v1/chat/completions",
    "http://localhost/v1/chat/completions?token=secret",
    "http://localhost/other",
  ])
    assert.throws(() => validateCodexEndpoint(value));
});

class FakeRpc extends EventEmitter {
  constructor({ account = "chatgpt", hang = false, failure = false } = {}) {
    super();
    this.calls = [];
    this.account = account;
    this.hang = hang;
    this.failure = failure;
  }
  send() {}
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "account/read") return { account: { type: this.account } };
    if (method === "config/read")
      return {
        config: { mcp_servers: { private_service: { enabled: true } } },
      };
    if (method === "model/list")
      return {
        data: [
          {
            model: "gpt-6-luna",
            supportedReasoningEfforts: [{ reasoningEffort: "low" }],
          },
        ],
      };
    if (method === "thread/start") return { thread: { id: "thread-test" } };
    if (method === "turn/start") {
      if (!this.hang)
        setImmediate(() => {
          this.emit("notification", {
            method: "item/agentMessage/delta",
            params: { threadId: "unrelated-thread", delta: "private" },
          });
          this.emit("notification", {
            method: "item/agentMessage/delta",
            params: { threadId: "thread-test", delta: "译文" },
          });
          this.emit("notification", {
            method: "turn/completed",
            params: {
              threadId: "thread-test",
              turn: {
                status: this.failure ? "failed" : "completed",
                error: this.failure ? { message: "Quota exceeded" } : null,
              },
            },
          });
        });
      return { turn: { id: "turn-test" } };
    }
    return {};
  }
}

test("subscription check rejects API billing and missing login before starting a turn", async () => {
  for (const account of ["apiKey", null]) {
    const rpc = new FakeRpc({ account });
    const translator = new CodexTranslator(rpc, "/tmp");
    await assert.rejects(
      translator.initialize(),
      /Sign in to Codex using ChatGPT/,
    );
    assert.ok(!rpc.calls.some((c) => c.method === "thread/start"));
  }
});

test("translation defaults to GPT-6 Luna with low reasoning and Fast mode in an isolated thread", async () => {
  const rpc = new FakeRpc();
  const translator = new CodexTranslator(rpc, "/tmp");
  await translator.initialize();
  const result = await translator.translate({
    messages: [{ role: "user", content: "source" }],
  });
  assert.equal(result.text, "译文");
  const start = rpc.calls.find((c) => c.method === "thread/start").params;
  assert.equal(start.model, "gpt-6-luna");
  assert.equal(start.serviceTier, "fast");
  assert.equal(start.config["features.fast_mode"], true);
  assert.equal(start.config.service_tier, "fast");
  assert.equal(start.config.model_reasoning_effort, "low");
  assert.equal(start.ephemeral, true);
  assert.equal(start.sandbox, "read-only");
  assert.equal(start.config["mcp_servers.private_service.enabled"], false);
  assert.equal(
    rpc.calls.find((c) => c.method === "turn/start").params.effort,
    "low",
  );
  assert.equal(
    rpc.calls.find((c) => c.method === "turn/start").params.serviceTier,
    "fast",
  );
  assert.equal(rpc.calls.at(-1).method, "thread/unsubscribe");
  assert.equal(rpc.listenerCount("notification"), 0);
});

test("timeout and client cancellation interrupt the active turn and clean listeners", async () => {
  for (const cancel of [false, true]) {
    const rpc = new FakeRpc({ hang: true });
    const translator = new CodexTranslator(rpc, "/tmp", { timeoutMs: 40 });
    await translator.initialize();
    const controller = new AbortController();
    const promise = translator.translate({
      messages: [{ role: "user", content: "source" }],
      signal: controller.signal,
    });
    if (cancel) setTimeout(() => controller.abort(), 10);
    await assert.rejects(promise, cancel ? /cancelled/ : /timed out/);
    assert.ok(rpc.calls.some((c) => c.method === "turn/interrupt"));
    assert.equal(rpc.calls.at(-1).method, "thread/unsubscribe");
    assert.equal(rpc.listenerCount("notification"), 0);
  }
});

test("failed Codex turns are errors even when partial output exists", async () => {
  const translator = new CodexTranslator(
    new FakeRpc({ failure: true }),
    "/tmp",
  );
  await translator.initialize();
  await assert.rejects(
    translator.translate({ messages: [{ role: "user", content: "text" }] }),
    /Quota/,
  );
});

test("RPC rejects outstanding requests if the subprocess exits", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  const rpc = new RpcClient(child, 100);
  const waiting = rpc.request("test");
  child.emit("exit", 1);
  await assert.rejects(waiting, /exited/);
  assert.equal(rpc.pending.size, 0);
  rpc.close();
});

async function fixture(t, { fail = false, delay = 0, timeout = 5000 } = {}) {
  let calls = 0;
  let cancelled = false;
  const translator = {
    models: [{ model: "test-model" }],
    chooseModel: () => ({ model: "test-model" }),
    async translate({ onDelta, signal }) {
      calls++;
      if (delay)
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delay);
          signal.addEventListener(
            "abort",
            () => {
              cancelled = true;
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true },
          );
        });
      onDelta?.("正确译文");
      if (fail) throw new BridgeError("Quota exceeded", 429, "quota");
      return { text: "正确译文", model: "test-model" };
    },
  };
  const server = createBridgeServer({
    translator,
    token,
    requestTimeoutMs: timeout,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.stop());
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = (body, headers = {}) =>
    fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  return { url, request, calls: () => calls, cancelled: () => cancelled };
}

const body = {
  model: "codex-auto",
  messages: [{ role: "user", content: "Text to translate" }],
};

test("HTTP blocks wrong tokens, website origins, DNS rebinding, malformed input, and tools without invoking Codex", async (t) => {
  const f = await fixture(t);
  for (const headers of [
    { Authorization: "Bearer wrong" },
    { Origin: "https://example.com" },
  ])
    assert.ok((await f.request(body, headers)).status >= 400);
  // fetch normalizes Host; a raw HTTP request exercises DNS-rebinding protection.
  const rebindingStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(
      f.url + "/health",
      { headers: { Host: "evil.test" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(rebindingStatus, 403);
  for (const invalid of [
    {},
    { ...body, messages: [{ role: "user", content: [] }] },
    { ...body, tools: [] },
    { ...body, messages: [{ role: "user", content: "x".repeat(50001) }] },
  ])
    assert.ok((await f.request(invalid)).status >= 400);
  assert.equal(f.calls(), 0);
});

test("HTTP returns OpenAI-compatible complete and streaming translations", async (t) => {
  const f = await fixture(t);
  const response = await f.request(body);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, "正确译文");
  const stream = await f.request({ ...body, stream: true });
  const parser = new CodexStreamParser();
  parser.feed(await stream.text());
  assert.equal(parser.finish(), "正确译文");
});

test("streamed backend failures reach plugin parser instead of a false success", async (t) => {
  const f = await fixture(t, { fail: true });
  const response = await f.request({ ...body, stream: true });
  const text = await response.text();
  assert.throws(() => new CodexStreamParser().feed(text), /Quota exceeded/);
});

test("HTTP deadline cancels model work and returns a useful error", async (t) => {
  const f = await fixture(t, { delay: 500, timeout: 30 });
  const response = await f.request(body);
  assert.equal(response.status, 504);
  assert.equal(f.cancelled(), true);
  assert.match((await response.json()).error.message, /timed out/);
});
