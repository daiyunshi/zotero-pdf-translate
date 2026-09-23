#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CodexTranslator } from "./codex-client.mjs";
import { createBridgeServer } from "./server.mjs";

const configPath =
  process.env.CODEX_TRANSLATE_CONFIG ||
  join(homedir(), ".config", "zotero-codex-translate", "config.json");
const command = process.argv[2] || "start";
if (!["start", "setup", "token"].includes(command)) {
  console.error("Usage: node bridge/cli.mjs [setup|start|token]");
  process.exit(1);
}
try {
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT")
      throw new Error(`Cannot read bridge config: ${configPath}`);
    config = {
      token: randomBytes(32).toString("hex"),
      port: 18765,
      origins: [],
    };
    await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
  }
  if (
    !Number.isInteger(config.port) ||
    config.port < 1024 ||
    config.port > 65535 ||
    typeof config.token !== "string" ||
    config.token.length < 24 ||
    !Array.isArray(config.origins) ||
    config.origins.some(
      (o) => typeof o !== "string" || o === "*" || o === "null",
    )
  )
    throw new Error("Invalid bridge config.");
  if (command === "token") {
    console.log(config.token);
  } else if (command === "setup") {
    console.log(
      `Configuration ready: ${configPath}\nEndpoint: http://127.0.0.1:${config.port}/v1/chat/completions\nModel: codex-auto\nUse 'node bridge/cli.mjs token' to copy your local token into Zotero.`,
    );
  } else {
    const translator = await CodexTranslator.start();
    const server = createBridgeServer({
      translator,
      token: config.token,
      origins: config.origins,
    });
    server.on("error", async (error) => {
      console.error(
        error.code === "EADDRINUSE"
          ? "Bridge port is already in use."
          : "Unable to start bridge.",
      );
      await translator.close();
      process.exitCode = 1;
    });
    server.listen(config.port, "127.0.0.1", () =>
      console.log(
        `Zotero translation ready: http://127.0.0.1:${config.port}/v1/chat/completions\nChatGPT subscription · ${translator.chooseModel().model} · low reasoning\nPress Ctrl+C to stop.`,
      ),
    );
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await server.stop();
      await translator.close();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
