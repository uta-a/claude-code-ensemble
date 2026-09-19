import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { CHECK, NO_GIT, cleanEnv, createFixture, dirOnPath, envWithPath, gitInit, runHook, writeFile } from "./helpers.mjs";

/** 実行されたらカレントディレクトリにマーカーを書くだけの軽い script */
const mark = (name) => `node -e "require('fs').writeFileSync('${name}.marker','')"`;

/** コミット済みの package.json と src/a.ts を持つ git リポジトリを作る。 */
function createRepo(t, scripts, extraFiles = {}) {
  const dir = createFixture(t);
  writeFile(dir, "package.json", JSON.stringify({ name: "fixture", private: true, scripts }));
  writeFile(dir, ".gitignore", "*.marker\n");
  writeFile(dir, "src/a.ts", "export const a = 1;\n");
  writeFile(dir, "README.md", "# fixture\n");
  for (const [rel, content] of Object.entries(extraFiles)) writeFile(dir, rel, content);
  gitInit(dir);
  return dir;
}

const ran = (dir, name) => fs.existsSync(path.join(dir, `${name}.marker`));

/** 時間切れテストの lint script が、開始マーカーから終了マーカーまで待つ時間 */
const LINT_SLEEP_MS = 4_000;

/** PATH を node / git / npm のあるディレクトリだけに絞る。そこに pnpm が紛れ込む環境では null。 */
function narrowedEnv() {
  const dirs = [path.dirname(process.execPath), dirOnPath("git"), dirOnPath("npm")].filter(Boolean);
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat"] : [""];
  if (dirs.some((d) => exts.some((ext) => fs.existsSync(path.join(d, `pnpm${ext}`))))) return null;
  return envWithPath(dirs);
}

/** node_modules/.bin に、必ず失敗する偽の lint ツールを置く（Windows は .cmd、他は sh）。 */
function installFailingTool(dir, name) {
  writeFile(dir, `node_modules/.bin/${name}.cmd`, "@echo src/a.ts: error fake-rule 1>&2\r\n@exit /b 2\r\n");
  const shim = writeFile(dir, `node_modules/.bin/${name}`, '#!/bin/sh\necho "src/a.ts: error fake-rule" >&2\nexit 2\n');
  fs.chmodSync(shim, 0o755);
}

test("変更済み .ts があっても typecheck は実行せず、lint だけを実行する", { skip: NO_GIT }, (t) => {
  const dir = createRepo(t, { typecheck: mark("typecheck"), lint: mark("lint") });
  writeFile(dir, "src/a.ts", "export const a = 2;\n");

  const r = runHook(CHECK, { cwd: dir });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(ran(dir, "typecheck"), false, "typecheck script が実行された");
  assert.equal(ran(dir, "lint"), true, "lint script が実行されなかった");
});

test("ドキュメントだけの変更では lint を実行しない", { skip: NO_GIT }, (t) => {
  const dir = createRepo(t, { lint: mark("lint") });
  writeFile(dir, "README.md", "# fixture\n\nupdated\n");

  const r = runHook(CHECK, { cwd: dir });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(ran(dir, "lint"), false);
});

test("lint が失敗したら block し、コマンド名と exit code を理由に含める", { skip: NO_GIT }, (t) => {
  const dir = createRepo(t, { lint: `node -e "console.error('src/a.ts: error no-unused-vars');process.exit(3)"` });
  writeFile(dir, "src/a.ts", "export const a = 2;\n");

  const r = runHook(CHECK, { cwd: dir });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /npm run lint \(exit 3\)/);
  assert.match(out.reason, /no-unused-vars/);
});

test("stop_hook_active なら何も実行しない", { skip: NO_GIT }, (t) => {
  const dir = createRepo(t, { lint: mark("lint") });
  writeFile(dir, "src/a.ts", "export const a = 2;\n");

  const r = runHook(CHECK, { cwd: dir, stop_hook_active: true });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(ran(dir, "lint"), false);
});

test("stdin が null でも落ちずに黙って終わる", () => {
  const r = runHook(CHECK, null);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "");
});

test("git リポジトリでなければ何もしない", (t) => {
  const dir = createFixture(t);
  writeFile(dir, "package.json", JSON.stringify({ name: "fixture", private: true, scripts: { lint: mark("lint") } }));
  writeFile(dir, "src/a.ts", "export const a = 2;\n");

  // tmpdir の上位が git リポジトリでも、そこまで遡らせない
  const r = runHook(CHECK, { cwd: dir }, { env: cleanEnv({ GIT_CEILING_DIRECTORIES: path.dirname(dir) }) });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(ran(dir, "lint"), false);
});

test("lint script が無ければ何もしない", { skip: NO_GIT }, (t) => {
  const dir = createRepo(t, { typecheck: mark("typecheck") });
  writeFile(dir, "src/a.ts", "export const a = 2;\n");

  const r = runHook(CHECK, { cwd: dir });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(ran(dir, "typecheck"), false);
});

test("lockfile が示す package manager が PATH に無ければ block しない", { skip: NO_GIT }, (t) => {
  const dir = createRepo(t, { lint: mark("lint") }, { "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" });
  writeFile(dir, "src/a.ts", "export const a = 2;\n");

  const env = narrowedEnv();
  if (!env) {
    t.skip("node / git / npm と同じディレクトリに pnpm がある環境では再現できない");
    return;
  }

  const r = runHook(CHECK, { cwd: dir }, { env });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /"decision":"block"/);
  assert.equal(r.stdout, "");
  assert.equal(ran(dir, "lint"), false);
});

test("陽性対照: 同じ絞った PATH でも、lockfile が無ければ（npm）lint を実行する", { skip: NO_GIT }, (t) => {
  const dir = createRepo(t, { lint: mark("lint") });
  writeFile(dir, "src/a.ts", "export const a = 2;\n");

  const env = narrowedEnv();
  if (!env || !dirOnPath("npm")) {
    t.skip("絞った PATH に npm を含められない環境では確認できない");
    return;
  }

  const r = runHook(CHECK, { cwd: dir }, { env });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(ran(dir, "lint"), true, "lint script が実行されなかった");
});

test("lint script のコマンドがどこにも無ければ block しない（npm install 前の clone）", { skip: NO_GIT }, (t) => {
  const dir = createRepo(t, { lint: "definitely-not-a-command-xyz ." });
  writeFile(dir, "src/a.ts", "export const a = 2;\n");

  const r = runHook(CHECK, { cwd: dir });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("陽性対照: node_modules/.bin にあるコマンドの lint が失敗したら block する", { skip: NO_GIT }, (t) => {
  const dir = createRepo(t, { lint: "fake-lint-tool ." });
  installFailingTool(dir, "fake-lint-tool");
  writeFile(dir, "src/a.ts", "export const a = 2;\n");

  const r = runHook(CHECK, { cwd: dir });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /npm run lint \(exit \d+\)/);
});

test("陽性対照: 上位ディレクトリの node_modules/.bin にあるコマンドも見つける（workspace）", { skip: NO_GIT }, (t) => {
  const dir = createRepo(t, {}, {
    "packages/app/package.json": JSON.stringify({ name: "app", private: true, scripts: { lint: "fake-lint-tool ." } }),
    "packages/app/src/b.ts": "export const b = 1;\n",
  });
  installFailingTool(dir, "fake-lint-tool");
  writeFile(dir, "packages/app/src/b.ts", "export const b = 2;\n");

  const r = runHook(CHECK, { cwd: path.join(dir, "packages", "app") });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).decision, "block");
});

test("陽性対照: shell 組み込みコマンドで始まる lint script は素通しで実行する", { skip: NO_GIT }, (t) => {
  const dir = createRepo(t, { lint: `cd src && ${mark("lint")}` });
  writeFile(dir, "src/a.ts", "export const a = 2;\n");

  const r = runHook(CHECK, { cwd: dir });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(ran(path.join(dir, "src"), "lint"), true, "lint script が実行されなかった");
});

test("時間切れでは block せず、lint のプロセスツリーごと止める", { skip: NO_GIT }, async (t) => {
  // 開始マーカーを書く → sleep → 終了マーカーを書く。budget は npm の起動より長く、sleep の終わりより短くする。
  const lint = `node -e "const fs=require('fs');fs.writeFileSync('start.marker','');setTimeout(()=>{fs.writeFileSync('end.marker','');process.exit(1)},${LINT_SLEEP_MS})"`;
  const dir = createRepo(t, { lint });
  writeFile(dir, "src/a.ts", "export const a = 2;\n");

  const r = runHook(CHECK, { cwd: dir }, { env: cleanEnv({ CLAUDE_ENSEMBLE_CHECK_BUDGET_MS: "3000" }) });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(ran(dir, "start"), true, "budget 内に lint script が始まらなかった");

  // 子プロセスが生き残っていれば、この間に終了マーカーを書く
  await sleep(LINT_SLEEP_MS + 2_000);
  assert.equal(ran(dir, "end"), false, "時間切れの後も lint の子プロセスが走り続けた");
});

test("lint の出力が上限（8MB）を超えたら block しない", { skip: NO_GIT }, (t) => {
  const dir = createRepo(t, { lint: `node -e "process.stdout.write('error '.repeat(1500000),()=>process.exit(1))"` });
  writeFile(dir, "src/a.ts", "export const a = 2;\n");

  const r = runHook(CHECK, { cwd: dir });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("出力が文字化けしているときは詳細を載せず、コマンド名と exit code だけを理由にする", { skip: NO_GIT }, (t) => {
  // cp932 の「エラー: 失敗しました」を 3 行。utf8 として読むと U+FFFD だらけになる
  const bytes = [0x83, 0x47, 0x83, 0x89, 0x81, 0x5b, 0x3a, 0x20, 0x8e, 0xb8, 0x94, 0x73, 0x82, 0xb5, 0x82, 0xdc, 0x82, 0xb5, 0x82, 0xbd, 0x0a];
  const lint = `node -e "const b=Buffer.from([${bytes.join(",")}]);process.stderr.write(Buffer.concat([b,b,b]));process.exit(1)"`;
  const dir = createRepo(t, { lint });
  writeFile(dir, "src/a.ts", "export const a = 2;\n");

  const r = runHook(CHECK, { cwd: dir });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /npm run lint \(exit 1\)/);
  assert.doesNotMatch(out.reason, /\uFFFD/);
});
