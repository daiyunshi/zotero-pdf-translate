/** Only the loopback translation bridge may receive its local access token. */
export function validateCodexEndpoint(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/v1/chat/completions"
  )
    throw new Error(
      "Use http://127.0.0.1:18765/v1/chat/completions for the local Codex bridge.",
    );
  return url.href;
}

/** Incremental SSE parser: packets may split anywhere, including inside 'data:'. */
export class CodexStreamParser {
  private buffer = "";
  result = "";
  done = false;
  stopped = false;

  feed(chunk: string): void {
    this.buffer += chunk;
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r?\n\r?\n/.exec(this.buffer))) {
      const event = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      if (data === "[DONE]") {
        this.done = true;
        continue;
      }
      const value = JSON.parse(data);
      if (value.error)
        throw new Error(value.error.message || "Codex translation failed.");
      const choice = value.choices?.[0];
      if (typeof choice?.delta?.content === "string")
        this.result += choice.delta.content;
      if (choice?.finish_reason === "stop") this.stopped = true;
      else if (choice?.finish_reason)
        throw new Error(`Translation ended early: ${choice.finish_reason}`);
    }
  }

  finish(): string {
    if (!this.done || !this.stopped || !this.result.trim())
      throw new Error("Translation was interrupted or empty. Please retry.");
    return this.result;
  }
}

export function parseCodexResponse(text: string): string {
  const value = JSON.parse(text);
  if (value.error)
    throw new Error(value.error.message || "Codex translation failed.");
  const choice = value.choices?.[0];
  if (
    choice?.finish_reason !== "stop" ||
    typeof choice.message?.content !== "string" ||
    !choice.message.content.trim()
  )
    throw new Error("Translation was interrupted or empty. Please retry.");
  return choice.message.content;
}
