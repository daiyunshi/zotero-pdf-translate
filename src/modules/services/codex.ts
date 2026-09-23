import { buildPromptParts, getPref, getString } from "../../utils";
import { TranslateService } from "./base";
import { hasSourceTextPlaceholder } from "./gptPrompt";
import {
  CodexStreamParser,
  parseCodexResponse,
  validateCodexEndpoint,
} from "./codexProtocol";

export const Codex: TranslateService = {
  id: "codex",
  type: "sentence",
  requireExternalConfig: true,
  helpUrl:
    "https://github.com/daiyunshi/zotero-pdf-translate/blob/codex/chatgpt-subscription-translation/docs/CODEX_TRANSLATION.md",

  async translate(data) {
    const endpoint = validateCodexEndpoint(String(getPref("codex.endPoint")));
    const token = String(getPref("codex.token") || "").trim();
    if (token.length < 24)
      throw new Error(getString("service-codex-token-required"));
    if (!hasSourceTextPlaceholder(String(getPref("codex.prompt"))))
      throw new Error(
        getString("service-gpt-dialog-prompt-required", {
          args: { placeholder: "${sourceText}" },
        }),
      );
    const { system, user } = buildPromptParts(
      "codex.prompt",
      data.langfrom,
      data.langto,
      data.raw,
      data,
    );
    const stream = Boolean(getPref("codex.stream"));
    const parser = new CodexStreamParser();
    const refresh = addon.api.getTemporaryRefreshHandler({ task: data });
    let position = 0;
    let streamError: Error | undefined;
    const readProgress = (xhr: XMLHttpRequest) => {
      if (streamError || xhr.status !== 200) return;
      try {
        parser.feed(xhr.responseText.slice(position));
        position = xhr.responseText.length;
        data.result = parser.result;
        refresh();
      } catch (error) {
        streamError = error as Error;
      }
    };
    let xhr: XMLHttpRequest;
    try {
      xhr = await Zotero.HTTP.request("POST", endpoint, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model: getPref("codex.model") || "gpt-6-luna",
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          stream,
        }),
        responseType: "text",
        timeout: 130000,
        followRedirects: false,
        successCodes: false,
        requestObserver: stream
          ? (request: XMLHttpRequest) => {
              request.onprogress = () => readProgress(request);
            }
          : undefined,
      });
    } catch {
      throw new Error(getString("service-codex-unavailable"));
    }
    if (xhr.status !== 200) {
      let message = `Codex bridge: HTTP ${xhr.status}`;
      try {
        message = JSON.parse(xhr.responseText).error?.message || message;
      } catch {
        /* Keep HTTP status. */
      }
      throw new Error(message);
    }
    if (stream) {
      readProgress(xhr);
      if (streamError) throw streamError;
      data.result = parser.finish();
    } else data.result = parseCodexResponse(xhr.responseText);
    refresh();
  },

  config(settings) {
    settings
      .addStaticRow("", {
        tag: "div",
        namespace: "html",
        styles: { maxWidth: "430px", whiteSpace: "pre-wrap" },
        properties: { textContent: getString("service-codex-description") },
      })
      .addTextSetting({
        prefKey: "codex.endPoint",
        nameKey: "service-chatgpt-dialog-endPoint",
      })
      .addPasswordSetting({
        prefKey: "codex.token",
        nameKey: "service-codex-token",
      })
      .addTextSetting({
        prefKey: "codex.model",
        nameKey: "service-codex-model",
      })
      .addTextAreaSetting({
        prefKey: "codex.prompt",
        nameKey: "service-chatgpt-dialog-prompt",
      })
      .addCheckboxSetting({
        prefKey: "codex.stream",
        nameKey: "service-chatgpt-dialog-stream",
      })
      .onSave((values) => {
        try {
          validateCodexEndpoint(values["codex.endPoint"]);
        } catch (error) {
          return (error as Error).message;
        }
        if (String(values["codex.token"] || "").trim().length < 24)
          return getString("service-codex-token-required");
        if (!hasSourceTextPlaceholder(values["codex.prompt"]))
          return getString("service-gpt-dialog-prompt-required", {
            args: { placeholder: "${sourceText}" },
          });
        return true;
      });
  },
};
