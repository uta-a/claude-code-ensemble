import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { REMIND, cleanEnv, runHook } from "./helpers.mjs";

const prompt = (text = "認証まわりを直して") => ({ session_id: "s1", prompt: text });

test("どのプロンプトにも委譲の基準を足す", () => {
  const r = runHook(REMIND, prompt());
  assert.equal(r.status, 0);
  assert.match(r.stdout, /ensemble の委譲モード/);
  assert.match(r.stdout, /ensemble:explore/);
});

test("CLAUDE_ENSEMBLE_REMIND=0 で何も足さない", () => {
  for (const value of ["0", "false", "OFF", " no "]) {
    const r = runHook(REMIND, prompt(), { env: { ...cleanEnv(), CLAUDE_ENSEMBLE_REMIND: value } });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  }
});

test("stdin が壊れていても、exit 0 で足すだけ", () => {
  for (const input of ["{not json", "null", ""]) {
    const r = spawnSync(process.execPath, [REMIND], { input, encoding: "utf8", env: cleanEnv(), timeout: 60_000 });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ensemble の委譲モード/);
    assert.equal(r.stderr, "");
  }
});
