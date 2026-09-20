#!/usr/bin/env node
/**
 * Delegation reminder for ensemble.
 *
 *   node remind.mjs   UserPromptSubmit hook: adds a short delegation reminder to every prompt
 *
 * - The plugin being installed is the switch: there is no mode to turn on and no state to keep.
 * - CLAUDE_ENSEMBLE_REMIND=0 (false / off / no) turns the reminder off.
 * - The hook never blocks a prompt: any failure exits 0 without output.
 */

const REMINDER = [
  "ensemble の委譲モード。このターンも次の基準で委譲を考える。",
  "- 場所や仕組みの調査で検索や読み込みの往復が要るなら ensemble:explore に任せ、結論だけ受け取る",
  "- 全体の test / build / typecheck や長いログを伴う検証は ensemble:test-runner に任せる",
  "- 互いに独立した実装は ensemble:implementer に並列で任せる",
  "- 後戻りしにくい設計判断は ensemble:architect、非自明な変更のコミット前確認は ensemble:reviewer",
  "- 意図と場所が明確な小さな修正は委譲せず直接やる。本体の文脈は判断と統合に使う",
].join("\n");

const OFF_VALUES = new Set(["0", "false", "off", "no"]);

function disabled() {
  const value = process.env.CLAUDE_ENSEMBLE_REMIND;
  return typeof value === "string" && OFF_VALUES.has(value.trim().toLowerCase());
}

if (!disabled()) process.stdout.write(REMINDER);
