#!/usr/bin/env node
/**
 * Stop hook for claude-ensemble.
 *
 * - Stateless: no arm/disarm, planner state, or agent counters.
 * - Runs lint only, and only when the changed files affect lint (not merely a dirty repo).
 * - Repo-wide typecheck is left to the test-runner agent.
 * - Documentation-only changes skip lint entirely.
 * - Lint runs under one time budget; when it runs out, the whole lint process tree is killed.
 * - Missing commands, launch failures, and budget exhaustion do not block Stop.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const DEFAULT_BUDGET_MS = 75_000;
const MAX_BUDGET_MS = 80_000; // plus git and the tree kill (up to 3s), stays under the Stop hook timeout in hooks.json (90s)
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024; // per stream, like spawnSync's maxBuffer
const MAX_REASON_LINES = 20;
const MAX_GARBLED_CHARS = 4;

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst", ".adoc"]);
const LINT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte",
  ".json", ".jsonc", ".css", ".scss", ".sass", ".less", ".yaml", ".yml",
]);
// Never on PATH (cmd.exe) or not reliably so (sh); a script starting with one is run as is.
const SHELL_BUILTINS = new Set(["cd", "echo", "set", "export", "exit", "call", "if", "for", "test", "true", "false", "type"]);

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8")) ?? {};
  } catch {
    return {};
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function budgetMs() {
  const raw = Number(process.env.CLAUDE_ENSEMBLE_CHECK_BUDGET_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_BUDGET_MS;
  return Math.min(Math.max(Math.floor(raw), 1_000), MAX_BUDGET_MS);
}

function gitNames(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (r.status !== 0) return null;
  return r.stdout.split("\0").filter(Boolean);
}

function changedFiles(cwd) {
  const unstaged = gitNames(cwd, ["diff", "--name-only", "-z", "--diff-filter=ACDMRTUXB"]);
  if (unstaged === null) return null; // not a git repo or git unavailable

  const staged = gitNames(cwd, ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACDMRTUXB"]) ?? [];
  const untracked = gitNames(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]) ?? [];
  return [...new Set([...unstaged, ...staged, ...untracked])];
}

function isDocumentation(file) {
  const normalized = file.replaceAll("\\", "/");
  const base = path.posix.basename(normalized).toLowerCase();
  const ext = path.posix.extname(normalized).toLowerCase();
  if (DOC_EXTENSIONS.has(ext)) return true;
  if (/^(readme|changelog|contributing|license|authors|notice)(\..*)?$/.test(base)) return true;
  return normalized.startsWith("docs/") || normalized.startsWith("doc/");
}

function packageManager(cwd) {
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(cwd, "bun.lockb")) || fs.existsSync(path.join(cwd, "bun.lock"))) return "bun";
  return "npm";
}

function pathDirs() {
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((dir) => dir.replace(/^"(.*)"$/, "$1")) // Windows PATH entries may be quoted
    .filter(Boolean);
}

function ancestors(cwd) {
  const dirs = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    dirs.push(dir);
    if (path.dirname(dir) === dir) return dirs;
  }
}

// Looked up with fs instead of relying on the shell's exit code (127 is POSIX-only).
function onPath(command, dirs = pathDirs()) {
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        if (fs.statSync(path.join(dir, command + ext)).isFile()) return true;
      } catch {}
    }
  }
  return false;
}

function affectsLint(file) {
  const normalized = file.replaceAll("\\", "/");
  const base = path.posix.basename(normalized).toLowerCase();
  const ext = path.posix.extname(normalized).toLowerCase();
  return LINT_EXTENSIONS.has(ext)
    || base === "package.json"
    || base.startsWith("eslint.config.")
    || base.startsWith(".eslintrc");
}

// A lint tool that is not installed (e.g. a clone before `npm install`) exits 1 on Windows,
// not 127, so it is looked up the way `<pm> run` would: each node_modules/.bin upward, then PATH.
function toolMissing(script, cwd) {
  const tool = script.trim().split(/\s+/)[0];
  if (!/^[\w.-]+$/.test(tool) || SHELL_BUILTINS.has(tool.toLowerCase())) return false; // not a plain command name
  const dirs = ancestors(cwd);
  if (dirs.some((dir) => fs.existsSync(path.join(dir, ".pnp.cjs")))) return false; // Yarn PnP has no .bin
  return !onPath(tool, [...dirs.map((dir) => path.join(dir, "node_modules", ".bin")), ...pathDirs()]);
}

function lintCheck(cwd, files) {
  if (files.every(isDocumentation)) return null;

  const pkg = readJson(path.join(cwd, "package.json"));
  const script = pkg?.scripts?.lint;
  if (typeof script !== "string" || !script || !files.some(affectsLint)) return null;
  if (toolMissing(script, cwd)) return null;

  const pm = packageManager(cwd);
  return { pm, cmd: `${pm} run lint` };
}

function extractErrorLines(output) {
  const lines = output.split("\n").filter((line) => /error|✖|✗|Error:/i.test(line));
  const picked = (lines.length ? lines : output.split("\n")).filter(Boolean).slice(-MAX_REASON_LINES);
  const detail = picked.join("\n");

  // Non-UTF-8 output (e.g. cp932 from cmd.exe) decodes to U+FFFD noise; drop it rather than report it.
  const garbled = detail.split("\uFFFD").length - 1;
  return garbled > MAX_GARBLED_CHARS ? "" : detail;
}

// Killing only the shell leaves npm / node / the lint tool running (and holding cwd on Windows).
function killTree(pid) {
  try {
    // Absolute path: PATH may not include System32.
    const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    if (process.platform === "win32") spawnSync(taskkill, ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 3_000 });
    else process.kill(-pid, "SIGKILL"); // the process group, see `detached` below
  } catch {}
}

// spawnSync's timeout / maxBuffer kill the shell only, so both limits are enforced here instead.
// Resolves to { status, stdout, stderr }; status null means no lint verdict.
function spawnLint(cmd, cwd, timeout) {
  return new Promise((resolve) => {
    const child = spawn(cmd, {
      cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== "win32", // own process group on POSIX; on Windows it would open a console
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = { stdout: [], stderr: [] };
    let settled = false;
    const done = (result) => {
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const giveUp = () => {
      if (settled) return;
      killTree(child.pid);
      // Do not wait for "close": a survivor holding the pipes must not keep the hook alive.
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      done({ status: null });
    };
    const timer = setTimeout(giveUp, timeout);

    for (const name of ["stdout", "stderr"]) {
      let size = 0;
      child[name].on("data", (chunk) => {
        chunks[name].push(chunk);
        if ((size += chunk.length) > MAX_OUTPUT_BYTES) giveUp();
      });
      child[name].on("error", () => {}); // a pipe error must not surface as an uncaught exception
    }
    child.on("error", () => done({ status: null }));
    child.on("close", (status) => done({
      status,
      stdout: Buffer.concat(chunks.stdout).toString("utf8"),
      stderr: Buffer.concat(chunks.stderr).toString("utf8"),
    }));
  });
}

async function run(check, cwd, timeout) {
  if (!onPath(check.pm)) return { ...check, status: "unavailable" };

  const r = await spawnLint(check.cmd, cwd, timeout);

  // status null: killed by a signal (timeout or an external kill) or never launched, not a lint verdict.
  // Negative: a failed launch reports -errno on "close".
  if (r.status === null || r.status < 0 || r.status === 127) return { ...check, status: "unavailable" };
  if (r.status === 0) return { ...check, status: "pass" };
  return {
    ...check,
    status: "fail",
    exitCode: r.status,
    detail: extractErrorLines(`${r.stdout ?? ""}\n${r.stderr ?? ""}`),
  };
}

async function main() {
  const input = readStdin();
  if (input.stop_hook_active === true) return;

  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const files = changedFiles(cwd);
  if (!files || files.length === 0) return;

  const check = lintCheck(cwd, files);
  if (!check) return;

  const result = await run(check, cwd, budgetMs());
  if (result.status !== "fail") return;

  const reason = [
    "変更内容に対応する検査が失敗しています。完了する前に直してください（自動リトライはこの1回だけです）。",
    "",
    [`- ${result.cmd} (exit ${result.exitCode ?? "unknown"})`, result.detail].filter(Boolean).join("\n"),
    "",
    "検査対象は作業ツリー全体です。このセッションで触っていないファイルのエラーは、直さずにその旨を報告してください。",
    "検査コマンド自体が壊れている場合は、直さずにその旨を報告して止まってください。",
  ].join("\n");

  process.stdout.write(JSON.stringify({ decision: "block", reason }));
}

main().catch(() => {}); // exit quietly, never with a stack trace
