import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { MODE, cleanEnv, runHook } from "./helpers.mjs";

const STATE_DIR = path.join(os.tmpdir(), "claude-ensemble", "mode");

/** /ensemble:on と /ensemble:off が呼ぶ CLI を実行する。 */
function setMode(command, sessionId) {
  return spawnSync(process.execPath, [MODE, command, sessionId], { encoding: "utf8", env: cleanEnv(), timeout: 60_000 });
}

/** テストごとに別のセッション ID を使い、終わったら必ず OFF に戻す。 */
function newSession(t) {
  const id = crypto.randomUUID();
  t.after(() => fs.rmSync(path.join(STATE_DIR, id), { force: true }));
  return id;
}

const prompt = (sessionId, text = "認証まわりを直して") => ({ session_id: sessionId, prompt: text });

test("OFF（既定）では、プロンプトに何も足さない", (t) => {
  const r = runHook(MODE, prompt(newSession(t)));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("ON の間は、委譲の基準をプロンプトに足す", (t) => {
  const id = newSession(t);
  assert.match(setMode("on", id).stdout, /ON にしました/);

  const r = runHook(MODE, prompt(id));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /委譲モードが ON/);
  assert.match(r.stdout, /ensemble:explore/);
});

test("OFF に戻すと、何も足さなくなる", (t) => {
  const id = newSession(t);
  setMode("on", id);
  assert.match(setMode("off", id).stdout, /OFF にしました/);

  assert.equal(runHook(MODE, prompt(id)).stdout, "");
});

test("ON / OFF を重ねて呼ぶと、現在の状態を伝える", (t) => {
  const id = newSession(t);
  assert.match(setMode("off", id).stdout, /もともと OFF/);
  setMode("on", id);
  assert.match(setMode("on", id).stdout, /すでに ON/);
});

test("ON は、そのセッションだけに効く", (t) => {
  setMode("on", newSession(t));
  assert.equal(runHook(MODE, prompt(newSession(t))).stdout, "");
});

test("/ensemble: で始まるプロンプトには足さない", (t) => {
  const id = newSession(t);
  setMode("on", id);
  assert.equal(runHook(MODE, prompt(id, "/ensemble:off")).stdout, "");
  assert.equal(runHook(MODE, prompt(id, "  /ensemble:run 調べて")).stdout, "");
});

test("パスとして不正な session_id では、ファイルを作らず何も足さない", () => {
  const escaped = path.join(STATE_DIR, "..", "ensemble-mode-escape-test");
  const r = setMode("on", "../ensemble-mode-escape-test");
  assert.match(r.stdout, /切り替えられませんでした/);
  assert.equal(fs.existsSync(escaped), false);
  assert.equal(runHook(MODE, prompt("../ensemble-mode-escape-test")).stdout, "");
});

test("stdin が壊れていても、exit 0 で何も出さない", () => {
  for (const input of ["{not json", "null"]) {
    const r = spawnSync(process.execPath, [MODE], { input, encoding: "utf8", env: cleanEnv(), timeout: 60_000 });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "");
  }
});
