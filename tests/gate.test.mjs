import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { GATE, cleanEnv, createFixture, runHookAsync } from "./helpers.mjs";

const implementerRole = /^description:\s*(.+)$/m.exec(
  fs.readFileSync(path.join(path.dirname(GATE), "..", "agents", "implementer.md"), "utf8"),
)[1];

/**
 * 127.0.0.1 の空きポートに Jev のモックを立てる。
 * reply(req, body) は { status, json } か { raw } か "hang"（応答しない）を返す。
 */
async function jevMock(t, reply) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8").on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw);
      requests.push({ url: req.url, headers: req.headers, body });
      const r = reply(body);
      if (r === "hang") return;
      res.writeHead(r.status ?? 200, { "Content-Type": "application/json" });
      res.end(r.raw ?? JSON.stringify(r.json));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { base: `http://127.0.0.1:${server.address().port}/v1`, requests };
}

const answers = (worth, direct, size = 0.4) => ({
  json: { model: "jev-1.13.0", answers: { worth: { noul: worth }, direct: { noul: direct }, size: { score: size, confidence: 0.9 } } },
});

const delegation = (overrides = {}) => ({
  session_id: "s1",
  hook_event_name: "PreToolUse",
  tool_name: "Agent",
  tool_input: {
    subagent_type: "ensemble:implementer",
    description: "定数名を変える",
    prompt: "src/a.ts の FOO を BAR に変える",
    ...overrides,
  },
});

const jevEnv = (base, extra = {}) =>
  cleanEnv({ TYPESAFE_API_KEY: "test-key", CLAUDE_ENSEMBLE_JEV: "gate", CLAUDE_ENSEMBLE_JEV_BASE_URL: base, ...extra });

const readLog = (file) =>
  fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

test("モードかキーが無ければ Jev に送らない", async (t) => {
  const jev = await jevMock(t, () => answers(0.1, 0.9));
  for (const env of [
    jevEnv(jev.base, { CLAUDE_ENSEMBLE_JEV: "" }),
    jevEnv(jev.base, { CLAUDE_ENSEMBLE_JEV: "on" }),
    jevEnv(jev.base, { TYPESAFE_API_KEY: "" }),
  ]) {
    const r = await runHookAsync(GATE, delegation(), { env });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  }
  assert.equal(jev.requests.length, 0);
});

test("ensemble 以外の subagent_type は判定しない", async (t) => {
  const jev = await jevMock(t, () => answers(0.1, 0.9));
  for (const type of ["general-purpose", "Explore", "other:implementer", "ensemble:unknown", undefined]) {
    const r = await runHookAsync(GATE, delegation({ subagent_type: type }), { env: jevEnv(jev.base) });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  }
  assert.equal(jev.requests.length, 0);
});

test("override: 付きは判定せずに通し、ログに残す", async (t) => {
  const jev = await jevMock(t, () => answers(0.1, 0.9));
  const log = path.join(createFixture(t), "jev.jsonl");
  const r = await runHookAsync(GATE, delegation({ prompt: "  Override: 並列で進めたい\n本文" }), {
    env: jevEnv(jev.base, { CLAUDE_ENSEMBLE_JEV_LOG: log }),
  });
  assert.equal(r.stdout, "");
  assert.equal(jev.requests.length, 0);
  assert.equal(readLog(log)[0].decision, "override");
});

test("閾値の境界で allow と deny が分かれる", async (t) => {
  const cases = [
    [0.249, 0.701, true],
    [0.25, 0.701, false],
    [0.249, 0.7, false],
    [0.9, 0.9, false],
  ];
  for (const [worth, direct, denied] of cases) {
    const jev = await jevMock(t, () => answers(worth, direct));
    const r = await runHookAsync(GATE, delegation(), { env: jevEnv(jev.base) });
    assert.equal(r.status, 0);
    if (!denied) {
      assert.equal(r.stdout, "", `worth=${worth} direct=${direct}`);
      continue;
    }
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(out.permissionDecision, "deny");
    assert.match(out.permissionDecisionReason, /override: <理由>/);
    assert.ok(out.permissionDecisionReason.includes(implementerRole));
  }
});

test("shadow では deny 条件でも止めず、would-deny を記録する", async (t) => {
  const jev = await jevMock(t, () => answers(0.1, 0.9));
  const log = path.join(createFixture(t), "jev.jsonl");
  const r = await runHookAsync(GATE, delegation(), {
    env: jevEnv(jev.base, { CLAUDE_ENSEMBLE_JEV: "Shadow", CLAUDE_ENSEMBLE_JEV_LOG: log }),
  });
  assert.equal(r.stdout, "");
  const [entry] = readLog(log);
  assert.equal(entry.decision, "would-deny");
  assert.equal(entry.worth, 0.1);
  assert.equal(entry.direct, 0.9);
  assert.equal(entry.size, 0.4);
  assert.equal(entry.model, "jev-1.13.0");
});

test("タイムアウト / 429 / 529 / 壊れた JSON / 数値でない回答では何も出さずに通す", async (t) => {
  const replies = [
    ["hang", "timeout"],
    [{ status: 429, json: { error: "rate" } }, 429],
    [{ status: 529, json: { error: "overloaded" } }, 529],
    [{ raw: "{not json" }, "fetch"],
    [{ json: { answers: { worth: { noul: "0.1" }, direct: { noul: 0.9 } } } }, "answers"],
    [{ json: null }, "answers"],
  ];
  for (const [reply, expected] of replies) {
    const jev = await jevMock(t, () => reply);
    const log = path.join(createFixture(t), "jev.jsonl");
    const started = Date.now();
    const r = await runHookAsync(GATE, delegation(), {
      env: jevEnv(jev.base, { CLAUDE_ENSEMBLE_JEV_BUDGET_MS: "300", CLAUDE_ENSEMBLE_JEV_LOG: log }),
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "");
    assert.ok(Date.now() - started < 5000);
    const [entry] = readLog(log);
    assert.equal(entry.decision, "error");
    assert.equal(entry.status ?? entry.error, expected);
  }
});

test("loopback 以外への http や不正な base URL には送らない", async (t) => {
  const log = path.join(createFixture(t), "jev.jsonl");
  const jev = await jevMock(t, () => answers(0.1, 0.9));
  const bases = [
    "http://api.example.com/v1",
    "ftp://127.0.0.1/v1",
    "not a url",
    jev.base.replace("http://", "http://user:pass@"),
    `${jev.base}?x=1`,
    `${jev.base}#a`,
  ];
  for (const base of bases) {
    const r = await runHookAsync(GATE, delegation(), { env: jevEnv(base, { CLAUDE_ENSEMBLE_JEV_LOG: log }) });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  }
  assert.equal(jev.requests.length, 0);
  assert.deepEqual(
    readLog(log).map((e) => e.error),
    bases.map(() => "base_url"),
  );
});

test("リダイレクトは追わずに通す", async (t) => {
  const target = await jevMock(t, () => answers(0.1, 0.9));
  // 転送先はモックの Jev。hook が転送を追えば target.requests に届く
  const server = http.createServer((req, res) => {
    req.resume().on("end", () => {
      res.writeHead(307, { Location: `${target.base}/systemone` });
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const log = path.join(createFixture(t), "jev.jsonl");
  const r = await runHookAsync(GATE, delegation(), {
    env: jevEnv(`http://127.0.0.1:${server.address().port}/v1`, { CLAUDE_ENSEMBLE_JEV_LOG: log }),
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(target.requests.length, 0);
  assert.equal(readLog(log)[0].error, "fetch");
});

test("http は IPv6 の loopback にも送れる", async (t) => {
  const server = http.createServer((req, res) => {
    req.resume().on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(answers(0.1, 0.9).json));
    });
  });
  try {
    await new Promise((resolve, reject) => server.once("error", reject).listen(0, "::1", resolve));
  } catch {
    t.skip("IPv6 の loopback が使えない");
    return;
  }
  t.after(() => server.close());
  const r = await runHookAsync(GATE, delegation(), { env: jevEnv(`http://[::1]:${server.address().port}/v1`) });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("ログは指定したときだけ書き、依頼文を含まない", async (t) => {
  const jev = await jevMock(t, () => answers(0.9, 0.1));
  const dir = createFixture(t);
  const secret = "SECRET-PROMPT-BODY";

  await runHookAsync(GATE, delegation({ prompt: secret }), { env: jevEnv(jev.base), cwd: dir });
  assert.equal(jev.requests.length, 1);
  assert.deepEqual(fs.readdirSync(dir), []);

  const log = path.join(dir, "jev.jsonl");
  await runHookAsync(GATE, delegation({ prompt: secret }), { env: jevEnv(jev.base, { CLAUDE_ENSEMBLE_JEV_LOG: log }) });
  const text = fs.readFileSync(log, "utf8");
  assert.ok(!text.includes(secret));
  const [entry] = readLog(log);
  assert.equal(entry.decision, "allow");
  assert.equal(entry.session_id, "s1");
  assert.equal(entry.description, "定数名を変える");
  assert.equal(entry.subagent_type, "ensemble:implementer");
  assert.equal(entry.brief_chars, secret.length);
});

test("リクエスト: Bearer 認証、固定版、role は agent の description、依頼文は 6000 字で切る", async (t) => {
  const jev = await jevMock(t, () => answers(0.9, 0.1));
  await runHookAsync(GATE, delegation({ prompt: "あ".repeat(7000) }), { env: jevEnv(jev.base) });
  const [req] = jev.requests;
  assert.equal(req.url, "/v1/systemone");
  assert.equal(req.headers.authorization, "Bearer test-key");
  assert.equal(req.body.model, "jev-1.13.0");
  assert.equal(req.body.state.specialist, "implementer");
  assert.equal(req.body.state.role, implementerRole);
  assert.equal(req.body.state.delegation_brief.length, 6000);
  assert.equal(req.body.questions.worth.type, "noul");
  assert.equal(req.body.questions.direct.type, "noul");
  assert.equal(req.body.questions.size.type, "score");
});

test("STRIP_CODE でコードブロックを除いて送り、MODEL で版を差し替えられる", async (t) => {
  const jev = await jevMock(t, () => answers(0.9, 0.1));
  const prompt = [
    "前",
    "```ts",
    "const token = 'x';",
    "```",
    "中1",
    "~~~",
    "tilde code",
    "~~~",
    "中2",
    "````md",
    "```",
    "inner fence",
    "```",
    "````",
    "後",
    "```",
    "閉じていない",
  ].join("\n");
  await runHookAsync(GATE, delegation({ prompt }), {
    env: jevEnv(jev.base, { CLAUDE_ENSEMBLE_JEV_STRIP_CODE: "1", CLAUDE_ENSEMBLE_JEV_MODEL: "jev-9.9.9" }),
  });
  const [req] = jev.requests;
  assert.equal(
    req.body.state.delegation_brief,
    ["前", "[code omitted]", "中1", "[code omitted]", "中2", "[code omitted]", "後", "[code omitted]"].join("\n"),
  );
  assert.equal(req.body.model, "jev-9.9.9");
});

test("stdin が壊れていても exit 0 で何も出さない", async (t) => {
  const jev = await jevMock(t, () => answers(0.1, 0.9));
  for (const input of ["{not json", "null", ""]) {
    const r = spawnSync(process.execPath, [GATE], { input, encoding: "utf8", env: jevEnv(jev.base), timeout: 60_000 });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "");
  }
});
