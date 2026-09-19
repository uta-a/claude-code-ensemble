#!/usr/bin/env node
/**
 * Delegation mode for ensemble: switched by the user, per session.
 *
 *   node mode.mjs on <session_id>    called by /ensemble:on
 *   node mode.mjs off <session_id>   called by /ensemble:off
 *   node mode.mjs                    UserPromptSubmit hook: while on, adds a short delegation reminder
 *
 * - The only state is one empty flag file per session under the OS temp dir. A new session starts off.
 * - The hook never blocks a prompt: any failure exits 0 without output.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_DIR = path.join(os.tmpdir(), "claude-ensemble", "mode");
const STALE_MS = 7 * 24 * 60 * 60 * 1000;
const COMMAND_PREFIX = "/ensemble:";

const REMINDER = [
  "ensemble の委譲モードが ON（解除は /ensemble:off）。このターンも次の基準で委譲を考える。",
  "- 場所や仕組みの調査で検索や読み込みの往復が要るなら ensemble:explore に任せ、結論だけ受け取る",
  "- 全体の test / build / typecheck や長いログを伴う検証は ensemble:test-runner に任せる",
  "- 互いに独立した実装は ensemble:implementer に並列で任せる",
  "- 後戻りしにくい設計判断は ensemble:architect、非自明な変更のコミット前確認は ensemble:reviewer",
  "- 意図と場所が明確な小さな修正は委譲せず直接やる。本体の文脈は判断と統合に使う",
].join("\n");

// session_id ends up in a file path, so only plain ids are accepted.
function flagFile(sessionId) {
  if (typeof sessionId !== "string" || !/^[\w-]{1,128}$/.test(sessionId)) return null;
  return path.join(STATE_DIR, sessionId);
}

// Sessions that were never switched off leave their flag behind; drop the old ones.
function removeStale() {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(STATE_DIR)) {
      const file = path.join(STATE_DIR, name);
      try {
        if (now - fs.statSync(file).mtimeMs > STALE_MS) fs.rmSync(file, { force: true });
      } catch {}
    }
  } catch {}
}

function setMode(command, sessionId) {
  const file = flagFile(sessionId);
  if (!file) {
    console.log("ensemble: セッション ID を取得できなかったため、委譲モードを切り替えられませんでした。");
    return;
  }
  try {
    const wasOn = fs.existsSync(file);
    if (command === "on") {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      removeStale();
      fs.writeFileSync(file, "");
      console.log(wasOn ? "ensemble: 委譲モードはすでに ON です。" : "ensemble: 委譲モードを ON にしました。");
    } else {
      fs.rmSync(file, { force: true });
      console.log(wasOn ? "ensemble: 委譲モードを OFF にしました。" : "ensemble: 委譲モードはもともと OFF です。");
    }
  } catch {
    console.log("ensemble: 委譲モードの切り替えに失敗しました。");
  }
}

function hook() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, "utf8")) ?? {};
  } catch {
    return;
  }
  // /ensemble:on, /ensemble:off and /ensemble:run carry their own instructions.
  if (typeof input.prompt === "string" && input.prompt.trimStart().startsWith(COMMAND_PREFIX)) return;

  const file = flagFile(input.session_id);
  if (file && fs.existsSync(file)) process.stdout.write(REMINDER);
}

const [command, sessionId] = process.argv.slice(2);
if (command === "on" || command === "off") setMode(command, sessionId);
else if (!command) hook();
