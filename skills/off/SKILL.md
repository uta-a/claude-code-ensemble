---
name: off
description: 委譲モードを OFF にし、通常の「迷ったら委譲しない」に戻す。
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/hooks/mode.mjs":*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/hooks/mode.mjs" off "${CLAUDE_SESSION_ID}"`

上のコマンドの出力を、そのままユーザーに伝えてください。
出力が無い、またはエラーになっている場合は、OFF にできたとは言わず、その内容をそのまま伝えてください。
再度有効にする場合は /ensemble:on を実行するよう1行で案内してください。
