/**
 * テスト共通の道具。
 *
 * fixture は os.tmpdir() 配下に作り、t.after で必ず削除する。
 * hook は子プロセスとして起動し、stdin に JSON を渡す。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const CHECK = path.join(here, "..", "hooks", "check.mjs");
export const FORMAT = path.join(here, "..", "hooks", "format.mjs");

/** git が無い環境では、gitInit を使うテストを fail ではなく skip にする。 */
export const NO_GIT = spawnSync("git", ["--version"]).status === 0 ? false : "git が見つからない";

/**
 * 一時ディレクトリを作る。t.after で必ず後始末する。
 * @param {import("node:test").TestContext} t
 */
export function createFixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-")));
  t.after(() => removeDir(dir));
  return dir;
}

/**
 * kill された直後の子プロセスが、一瞬だけ cwd を握っていることがある（Windows）。
 * Node 24 の rmSync は、この EPERM を maxRetries で再試行せず即座に投げるので、自前で数回だけ再試行する。
 */
async function removeDir(dir) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      return;
    } catch (err) {
      if (attempt >= 4) throw err;
      await sleep(200);
    }
  }
}

/** fixture にファイルを書く。親ディレクトリは自動で作る。 */
export function writeFile(dir, rel, content) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** fixture を git リポジトリにし、その時点の内容をコミットする。 */
export function gitInit(dir) {
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  };
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");
}

/** 開発者の CLAUDE_ENSEMBLE_* を除いた環境変数を返す。extra で上書き・追加できる。 */
export function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith("CLAUDE_ENSEMBLE_")) env[key] = value;
  }
  return { ...env, ...extra };
}

/** hook を子プロセスで起動し、stdin に JSON を渡す。 */
export function runHook(script, input, { env } = {}) {
  return spawnSync(process.execPath, [script], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: env ?? cleanEnv(),
    timeout: 60_000,
  });
}

/** PATH 上でコマンドのあるディレクトリを返す（外部コマンドは起動しない）。 */
export function dirOnPath(command) {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat"] : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    if (exts.some((ext) => fs.existsSync(path.join(dir, command + ext)))) return dir;
  }
  return null;
}

/** PATH だけを差し替えた環境変数を返す（Windows の Path など大文字小文字違いも除く）。 */
export function envWithPath(dirs) {
  const env = {};
  for (const [key, value] of Object.entries(cleanEnv())) {
    if (key.toUpperCase() !== "PATH") env[key] = value;
  }
  env.PATH = dirs.join(path.delimiter);
  return env;
}
