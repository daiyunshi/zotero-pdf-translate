# Zotero Codex translation fork

- Goal: use a ChatGPT subscription through the official Codex App Server and show translations in the existing Zotero reader popup.
- Upstream: windingwind/zotero-pdf-translate, commit `0f16acd2b76ba286c79f008eff1ef8468ed8fc2f` (2.4.7).
- Fork: daiyunshi/zotero-pdf-translate; branch `codex/chatgpt-subscription-translation`.
- Agent and execution environment: mac-work, local macOS; Node 24.18.0. No remote compute or local model weights.
- Implementation: dedicated Codex provider, loopback HTTP bridge, ephemeral App Server threads, subscription-only authentication, streaming and non-streaming responses.
- Defaults (2026-09-23, version 2.4.7-codex.2): fixed gpt-6-luna, low reasoning (the lowest level advertised by this Codex subscription catalog), and Fast mode. App Server readback confirmed model gpt-6-luna, reasoning low, and service tier priority (Fast). No global Codex settings were changed.
- Verification: 12 automated tests, TypeScript and ESLint checks, and production XPI build pass. Updated Zotero's native provider completed a synthetic translation in 2.55 seconds with gpt-6-luna; installed version and persisted model preference were verified. No library items were created or modified by the tests.
- Runtime: loopback port 18765; subscription login verified; original XPI backed up locally. Other translation services retain their settings.
- Implementation and local validation complete. Release bundle contains the XPI, dependency-free bridge, macOS launcher, and setup guide. Immersive Translation remains a separate optional validation.
- Publication: source and read-only build CI are available in the fork. A public binary-release workflow was not enabled because automatic approval rejected its persistent repository write permission; installation bundles are provided locally.
- Setup and recovery: see `docs/CODEX_TRANSLATION.md`.
