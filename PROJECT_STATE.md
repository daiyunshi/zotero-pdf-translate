# Zotero Codex translation fork

- Goal: use a ChatGPT subscription through the official Codex App Server and show translations in the existing Zotero reader popup.
- Upstream: windingwind/zotero-pdf-translate, commit `0f16acd2b76ba286c79f008eff1ef8468ed8fc2f` (2.4.7).
- Fork: daiyunshi/zotero-pdf-translate; branch `codex/chatgpt-subscription-translation`.
- Agent and execution environment: mac-work, local macOS; Node 24.18.0. No remote compute or local model weights.
- Implementation: dedicated Codex provider, loopback HTTP bridge, ephemeral App Server threads, subscription-only authentication, streaming and non-streaming responses.
- Verification: 12 automated tests, TypeScript and ESLint checks, and production XPI build pass. Live translation through Zotero's native provider succeeded in 2.8 seconds with gpt-5.6-luna; the installed provider and configuration dialog were verified in Zotero. No library items were created or modified by the tests.
- Runtime: loopback port 18765; subscription login verified; original XPI backed up locally. Other translation services retain their settings.
- Implementation and local validation complete. Release bundle contains the XPI, dependency-free bridge, macOS launcher, and setup guide. Immersive Translation remains a separate optional validation.
- Setup and recovery: see `docs/CODEX_TRANSLATION.md`.
