#!/usr/bin/env node
/**
 * PostToolUse hook for Edit / Write.
 *
 * Runs the project-local Prettier package's bin script with the current Node
 * (no .bin wrapper, no shell). If formatting is disabled, the file is outside the project (cwd),
 * Prettier is absent, the extension is unsupported, or formatting fails, exit quietly.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Covers every code extension check.mjs lints; the remaining differences (e.g. .md here) are intentional.
const EXT = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte",
  ".json", ".css", ".scss", ".md", ".yaml", ".yml",
]);
const disabled = /^(0|false|off|no)$/i.test(process.env.CLAUDE_ENSEMBLE_FORMAT ?? "");
if (disabled) process.exit(0);

let input = {};
try {
  input = JSON.parse(fs.readFileSync(0, "utf8")) ?? {};
} catch {}

// Symlinks, junctions and 8.3 short names would defeat the lexical project boundary check.
// The native variant is needed for short names. A path that does not exist is returned as is.
function realpath(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

const cwd = realpath(typeof input.cwd === "string" && input.cwd ? path.resolve(input.cwd) : process.cwd());

const raw = input?.tool_input?.file_path;
if (typeof raw !== "string" || !raw) process.exit(0);

// Absolute and real from here on: one base for every lookup, and never parsed as an option by Prettier.
const file = realpath(path.resolve(cwd, raw));
if (!EXT.has(path.extname(file).toLowerCase()) || !fs.existsSync(file)) process.exit(0);

// Resolve the package's own bin script. The .bin wrapper is a .cmd on Windows,
// which Node cannot spawn without a shell.
function prettierBin(nodeModules) {
  const pkgDir = path.join(nodeModules, "prettier");
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  } catch {
    return null;
  }

  const rel = typeof pkg?.bin === "string" ? pkg.bin : pkg?.bin?.prettier;
  if (typeof rel !== "string") return null;

  const bin = path.resolve(pkgDir, rel);
  if (!bin.startsWith(pkgDir + path.sep)) return null; // never run a script outside the package
  return fs.existsSync(bin) ? bin : null;
}

// path.relative compares whole segments (/proj vs /proj2) and ignores case on Windows.
function insideProject(dir, boundary) {
  const rel = path.relative(boundary, dir);
  return !(rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel));
}

function localPrettier(start, projectRoot) {
  let dir = path.resolve(start);
  const boundary = path.resolve(projectRoot);

  // A file outside the project is left alone: neither its own Prettier nor the project's is used.
  if (!insideProject(dir, boundary)) return null;
  while (true) {
    const candidate = prettierBin(path.join(dir, "node_modules"));
    if (candidate) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir || !insideProject(parent, boundary)) return null;
    dir = parent;
  }
}

const prettier = localPrettier(path.dirname(file), cwd);
if (!prettier) process.exit(0);

// The result (including spawn errors) is ignored on purpose: formatting is best-effort.
spawnSync(process.execPath, [prettier, "--write", "--log-level", "silent", file], {
  cwd,
  timeout: 20_000,
  shell: false,
  stdio: "ignore",
});

process.exit(0);
