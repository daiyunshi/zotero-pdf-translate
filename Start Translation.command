#!/bin/bash
set -e
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  . "$HOME/.nvm/nvm.sh"
fi
if ! command -v node >/dev/null 2>&1; then
  echo "请先安装 Node.js 22 或更新版本，然后重新打开。"
  read -r -p "按回车退出。" codex_translate_reply
  exit 1
fi
node bridge/cli.mjs start || {
  read -r -p "服务未能启动。请检查上方提示，按回车退出。" codex_translate_reply
  exit 1
}
