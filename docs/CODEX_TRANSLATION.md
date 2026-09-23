# 在 Zotero 中使用 ChatGPT 订阅翻译

此 fork 增加 **ChatGPT 订阅（Codex）** 服务。选中文字后，译文仍在原来的阅读器弹窗和侧栏内逐步显示。

数据流：Zotero → 本机翻译服务 → 官方 Codex App Server → ChatGPT 订阅中的 Codex 模型。

需要订阅本身包含 Codex 使用权限；受 Codex 的额度、模型可用性和服务条款约束。这不是 OpenAI API 额度。使用官方登录，不读取浏览器 Cookie，不使用网页逆向接口。仅接受 ChatGPT 登录，拒绝 API-key 账号，没有收费 API 回退。

## 初次使用

需要 Node.js 22 或更新版本，以及使用 ChatGPT 登录的 [Codex CLI](https://developers.openai.com/codex/cli)。不需要下载本地大模型。

1. 在 Zotero → 工具 → 插件 → 齿轮 → 从文件安装插件，选择 `translate-for-zotero-codex.xpi`。本版本沿用原插件 ID，替换原版本并保留设置。保留官方 XPI 可随时装回。
2. 解压配套文件包，在文件包目录运行：

   ```sh
   codex login
   node bridge/cli.mjs setup
   node bridge/cli.mjs start
   ```

   已使用 ChatGPT 登录 Codex 时无需重新登录。显示 `Zotero translation ready` 后保持运行；macOS 也可双击 `Start Translation.command`。本版本不会自动修改开机启动项。

3. 在另一个终端复制连接密钥。macOS 可直接复制到剪贴板：

   ```sh
   node bridge/cli.mjs token | pbcopy
   ```

   这只是本地连接密钥，**不是 OpenAI API key**。配置保存在 `~/.config/zotero-codex-translate/config.json`，不要上传此文件。

4. Zotero → 设置 → 翻译 → 服务，选择 **ChatGPT 订阅（Codex）**，打开服务设置：

   | 设置             | 值                                           |
   | ---------------- | -------------------------------------------- |
   | 地址             | `http://127.0.0.1:18765/v1/chat/completions` |
   | 本地服务连接密钥 | 上一步复制的密钥                             |
   | 模型             | `gpt-6-luna`                                 |
   | 流式输出         | 开启                                         |

5. 在 PDF 中选取完整句子测试。若启用单词词典，单个单词仍使用原词典服务。

## 模型和资源

默认固定使用 `gpt-6-luna`、`low` 推理档和 Fast 模式。2026-09-23 实际查询 Codex 模型目录，`low` 是此订阅路径为 GPT-6 Luna 开放的最低推理档位；API 文档中的 `none` 不等同于 Codex 可选档位。模型不存在时直接报错，不会自动替换。

Fast 模式使用官方 `service_tier = "fast"` 和 `features.fast_mode = true`，仅作用于本翻译服务。根据 [Codex 官方说明](https://learn.chatgpt.com/docs/agent-configuration/speed)，GPT-6 Luna 的 Fast 模式按普通模式的 2.5 倍消耗 credits，仍受订阅额度约束。

需要自动选择可用模型时，可手动改为 `codex-auto`：优先选择 `gpt-6-luna`、`gpt-5.6-luna` 等轻量模型，没有候选时使用账号默认模型。也可填写已开放的模型名。

提示词要求保留否定、不确定性、数字、引文及基因/蛋白符号。仍需核对专业术语。本服务一次处理一个请求，最多等待 4 个请求，整个请求限时 120 秒；网络、文本长度和订阅排队会影响延迟。

本机只运行 Node 服务和 Codex App Server，不加载模型权重。**翻译文本会发送到 OpenAI。** 每次使用独立临时会话，不读取已有对话。桥接服务不记录原文、译文或登录凭据；Codex/OpenAI 的数据保留规则和 Zotero 上游调试日志行为仍然适用。

运行目录为空的临时目录，关闭项目指令、记忆、Shell、浏览器、应用、插件和已配置 MCP，使用只读沙箱并拒绝工具/审批请求。只监听 `127.0.0.1`，验证随机密钥、Origin 和 Host。不会修改原有 Codex 配置。

## 沉浸式翻译 / 原版 Custom GPT

服务提供精简的 OpenAI Chat Completions 兼容接口。完整地址为 `http://127.0.0.1:18765/v1/chat/completions`；若客户端要求 Base URL，填 `http://127.0.0.1:18765/v1`。API key 填本地连接密钥，模型填 `gpt-6-luna`。

支持文本消息及流式/非流式输出；`temperature`、`max_tokens` 等参数不会改变 Codex 推理设置。不支持工具、多模态或 Responses API。原版 Custom GPT 的错误呈现受自身解析器限制，推荐本 fork 的专用服务。

浏览器扩展若发送 Origin，需要把它的**确切 Origin** 加入本地配置的 `origins` 数组后重启服务，例如 `chrome-extension://实际扩展ID`。不支持 `*` 或 `null` 通配放行。沉浸式翻译尚需按具体扩展版本单独验证。

## 排查与恢复

- 无法连接：保持服务运行，检查地址。`http://127.0.0.1:18765/health` 提供健康检查；Codex 进程退出后需重启服务。
- 需要登录：运行 `codex login`，选择 ChatGPT 登录后重启服务。
- 密钥无效：重新复制 `node bridge/cli.mjs token` 的结果。
- 额度/模型错误：检查 Codex 额度和可用模型。不会绕过限制或改用 API 余额。
- 找不到命令：安装官方 Node/Codex；可用 `CODEX_TRANSLATE_BIN` 指定 Codex 可执行文件。
- 端口占用：确认是否已运行服务；换端口需同时修改本地配置 `port` 和插件地址。
- 恢复官方版本：安装上游 XPI，并选回原来的翻译服务。本 fork 不改其他服务设置。

## 开发

```sh
npm ci --ignore-scripts
npm run test:bridge
npm run build
```

桥接服务运行时只使用 Node 标准库。自动测试使用模拟 App Server，覆盖订阅身份检查、会话隔离、取消、超时、子进程退出、HTTP 鉴权及 SSE 分包解析，不消耗订阅额度。真实验证需从 Zotero 翻译合成测试句。

参考 [官方 App Server 文档](https://developers.openai.com/codex/app-server)。保留原项目版权，采用 AGPL-3.0-or-later。
