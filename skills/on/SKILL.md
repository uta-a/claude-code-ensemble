---
name: on
description: 委譲モードを ON にする。このセッションの間、毎ターン委譲の判断基準を思い出させ、調査や長い出力を伴う作業を specialist に寄せる。
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/hooks/mode.mjs":*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/hooks/mode.mjs" on "${CLAUDE_SESSION_ID}"`

上のコマンドの出力を、そのままユーザーに伝えてください。
出力が無い、またはエラーになっている場合は、ON にできたとは言わず、その内容をそのまま伝えてください。
ON にできた場合は、効くのはこのセッションの間だけで、/ensemble:off で解除できること、新しいセッションでは OFF に戻ることを1行で添えてください。
