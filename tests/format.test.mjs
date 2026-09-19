import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { FORMAT, cleanEnv, createFixture, runHook, writeFile } from "./helpers.mjs";

const MARKER = "// formatted by fake prettier\n";
const NESTED_MARKER = "// formatted by nested fake prettier\n";

// 最後の引数のファイルにマーカーを追記する偽 prettier
const fakeBin = (marker) => `
const fs = require("node:fs");
fs.appendFileSync(process.argv.at(-1), ${JSON.stringify(marker)});
`;
const FAKE_BIN = fakeBin(MARKER);

/** 偽の project-local prettier を置く。npm と同じく .bin のラッパーも作る。 */
function installFakePrettier(dir, bin, binPath, marker = MARKER) {
  writeFile(dir, "node_modules/prettier/package.json", JSON.stringify({ name: "prettier", version: "0.0.0", bin }));
  writeFile(dir, `node_modules/prettier/${binPath}`, fakeBin(marker));
  writeFile(dir, "node_modules/.bin/prettier.cmd", `@node "%~dp0\\..\\prettier\\${binPath.replaceAll("/", "\\")}" %*\r\n`);
  const shim = writeFile(dir, "node_modules/.bin/prettier", `#!/bin/sh\nexec node "$(dirname "$0")/../prettier/${binPath}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
}

/**
 * ディレクトリへの link を作る（win32 は権限の要らない junction）。作れない環境では false を返す。
 * link も実体も同じ fixture の中に置くこと。fixture の削除（rmSync recursive）は link を辿らない。
 */
function linkDir(target, link) {
  try {
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

/** 8.3 短縮名でのパスを返す。短縮名が無い（生成が無効な）環境では null を返す。 */
function shortPath(dir) {
  const r = spawnSync("cmd.exe", ["/d", "/s", "/c", `"for %I in ("${dir}") do @echo %~sI"`], {
    encoding: "utf8",
    windowsVerbatimArguments: true,
  });
  const short = (r.stdout ?? "").trim();
  return short && short.toLowerCase() !== dir.toLowerCase() && fs.existsSync(short) ? short : null;
}

function format(cwd, file, options) {
  return runHook(FORMAT, { cwd, tool_name: "Edit", tool_input: { file_path: file } }, options);
}

function assertSilent(result) {
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
}

test("project-local の prettier（bin がオブジェクト）で対象ファイルを整形する", (t) => {
  const dir = createFixture(t);
  installFakePrettier(dir, { prettier: "./bin/prettier.cjs" }, "bin/prettier.cjs");
  const file = writeFile(dir, "src/a.ts", "const a = 1;\n");

  assertSilent(format(dir, file));
  assert.equal(fs.readFileSync(file, "utf8"), `const a = 1;\n${MARKER}`);
});

test("bin が文字列の prettier（v2 形式）でも整形する", (t) => {
  const dir = createFixture(t);
  installFakePrettier(dir, "./bin-prettier.js", "bin-prettier.js");
  const file = writeFile(dir, "a.json", "{}\n");

  assertSilent(format(dir, file));
  assert.equal(fs.readFileSync(file, "utf8"), `{}\n${MARKER}`);
});

test("深いディレクトリのファイルでも、親へ遡って prettier を見つける", (t) => {
  const dir = createFixture(t);
  installFakePrettier(dir, { prettier: "./bin/prettier.cjs" }, "bin/prettier.cjs");
  const file = writeFile(dir, "packages/app/src/deep/a.ts", "const a = 1;\n");

  assertSilent(format(dir, file));
  assert.equal(fs.readFileSync(file, "utf8"), `const a = 1;\n${MARKER}`);
});

test("prettier が無ければ黙って何もしない", (t) => {
  const dir = createFixture(t);
  const file = writeFile(dir, "src/a.ts", "const a = 1;\n");

  assertSilent(format(dir, file));
  assert.equal(fs.readFileSync(file, "utf8"), "const a = 1;\n");
});

test("bin がパッケージの外を指していれば実行しない", (t) => {
  const dir = createFixture(t);
  writeFile(dir, "node_modules/prettier/package.json", JSON.stringify({ name: "prettier", bin: "../../outside.cjs" }));
  writeFile(dir, "outside.cjs", FAKE_BIN);
  const file = writeFile(dir, "src/a.ts", "const a = 1;\n");

  assertSilent(format(dir, file));
  assert.equal(fs.readFileSync(file, "utf8"), "const a = 1;\n");
});

test("対象外の拡張子は整形しない", (t) => {
  const dir = createFixture(t);
  installFakePrettier(dir, { prettier: "./bin/prettier.cjs" }, "bin/prettier.cjs");
  const file = writeFile(dir, "src/a.py", "a = 1\n");

  assertSilent(format(dir, file));
  assert.equal(fs.readFileSync(file, "utf8"), "a = 1\n");
});

test(".vue は整形対象に含まれる", (t) => {
  const dir = createFixture(t);
  installFakePrettier(dir, { prettier: "./bin/prettier.cjs" }, "bin/prettier.cjs");
  const file = writeFile(dir, "src/App.vue", "<template></template>\n");

  assertSilent(format(dir, file));
  assert.equal(fs.readFileSync(file, "utf8"), `<template></template>\n${MARKER}`);
});

test("CLAUDE_ENSEMBLE_FORMAT=0 なら何もしない", (t) => {
  const dir = createFixture(t);
  installFakePrettier(dir, { prettier: "./bin/prettier.cjs" }, "bin/prettier.cjs");
  const file = writeFile(dir, "src/a.ts", "const a = 1;\n");

  assertSilent(format(dir, file, { env: cleanEnv({ CLAUDE_ENSEMBLE_FORMAT: "0" }) }));
  assert.equal(fs.readFileSync(file, "utf8"), "const a = 1;\n");
});

test("file_path が文字列でなければ、落ちずに黙って終わる", (t) => {
  const dir = createFixture(t);

  const r = format(dir, 123);
  assertSilent(r);
  assert.equal(r.stderr, "");
});

test("stdin が null でも落ちずに黙って終わる", () => {
  const r = runHook(FORMAT, null);
  assertSilent(r);
  assert.equal(r.stderr, "");
});

test("相対パスの file_path は cwd を基準に解決する", (t) => {
  const dir = createFixture(t);
  installFakePrettier(dir, { prettier: "./bin/prettier.cjs" }, "bin/prettier.cjs");
  const file = writeFile(dir, "src/a.ts", "const a = 1;\n");

  assertSilent(format(dir, path.join("src", "a.ts")));
  assert.equal(fs.readFileSync(file, "utf8"), `const a = 1;\n${MARKER}`);
});

test("名前が前方一致するだけの兄弟ディレクトリはプロジェクト外として扱い、そこに prettier があっても整形しない", (t) => {
  const dir = createFixture(t);
  const proj = path.join(dir, "proj");
  const proj2 = path.join(dir, "proj2");
  installFakePrettier(proj, { prettier: "./bin/prettier.cjs" }, "bin/prettier.cjs");
  installFakePrettier(proj2, { prettier: "./bin/prettier.cjs" }, "bin/prettier.cjs", NESTED_MARKER);
  const file = writeFile(proj2, "src/a.ts", "const a = 1;\n");

  assertSilent(format(proj, file));
  assert.equal(fs.readFileSync(file, "utf8"), "const a = 1;\n");
});

test("プロジェクト外のファイルは、cwd に prettier があっても整形しない", (t) => {
  const dir = createFixture(t);
  const proj = path.join(dir, "proj");
  installFakePrettier(proj, { prettier: "./bin/prettier.cjs" }, "bin/prettier.cjs");
  const file = writeFile(dir, "other/src/a.ts", "const a = 1;\n");

  assertSilent(format(proj, file));
  assert.equal(fs.readFileSync(file, "utf8"), "const a = 1;\n");
});

test("cwd の大文字小文字が違っても、入れ子パッケージの最寄りの prettier を使う", { skip: process.platform !== "win32" && "win32 のみ" }, (t) => {
  const dir = createFixture(t);
  installFakePrettier(dir, { prettier: "./bin/prettier.cjs" }, "bin/prettier.cjs");
  installFakePrettier(path.join(dir, "packages", "app"), { prettier: "./bin/prettier.cjs" }, "bin/prettier.cjs", NESTED_MARKER);
  const file = writeFile(dir, "packages/app/src/a.ts", "const a = 1;\n");

  const swapped = dir === dir.toUpperCase() ? dir.toLowerCase() : dir.toUpperCase();
  assertSilent(format(swapped, file));
  assert.equal(fs.readFileSync(file, "utf8"), `const a = 1;\n${NESTED_MARKER}`);
});

test("入れ子パッケージでは、ルートではなく最寄りの prettier を使う", (t) => {
  const dir = createFixture(t);
  installFakePrettier(dir, { prettier: "./bin/prettier.cjs" }, "bin/prettier.cjs");
  installFakePrettier(path.join(dir, "packages", "app"), { prettier: "./bin/prettier.cjs" }, "bin/prettier.cjs", NESTED_MARKER);
  const file = writeFile(dir, "packages/app/src/a.ts", "const a = 1;\n");

  assertSilent(format(dir, file));
  assert.equal(fs.readFileSync(file, "utf8"), `const a = 1;\n${NESTED_MARKER}`);
});

test("cwd が link 経由、file_path が実パスでも、プロジェクト内として整形する", (t) => {
  const dir = createFixture(t);
  const real = path.join(dir, "real");
  installFakePrettier(real, { prettier: "./bin/prettier.cjs" }, "bin/prettier.cjs");
  const file = writeFile(real, "src/a.ts", "const a = 1;\n");
  const link = path.join(dir, "link");
  if (!linkDir(real, link)) return t.skip("link を作れない");

  assertSilent(format(link, file));
  assert.equal(fs.readFileSync(file, "utf8"), `const a = 1;\n${MARKER}`);
});

test("cwd が実パス、file_path が link 経由でも、プロジェクト内として整形する", (t) => {
  const dir = createFixture(t);
  const real = path.join(dir, "real");
  installFakePrettier(real, { prettier: "./bin/prettier.cjs" }, "bin/prettier.cjs");
  const file = writeFile(real, "src/a.ts", "const a = 1;\n");
  const link = path.join(dir, "link");
  if (!linkDir(real, link)) return t.skip("link を作れない");

  assertSilent(format(real, path.join(link, "src", "a.ts")));
  assert.equal(fs.readFileSync(file, "utf8"), `const a = 1;\n${MARKER}`);
});

test("cwd が 8.3 短縮名でも、プロジェクト内として整形する", { skip: process.platform !== "win32" && "win32 のみ" }, (t) => {
  const dir = createFixture(t);
  installFakePrettier(dir, { prettier: "./bin/prettier.cjs" }, "bin/prettier.cjs");
  const file = writeFile(dir, "src/a.ts", "const a = 1;\n");
  const short = shortPath(dir);
  if (!short) return t.skip("8.3 短縮名が無い");

  assertSilent(format(short, file));
  assert.equal(fs.readFileSync(file, "utf8"), `const a = 1;\n${MARKER}`);
});

test("プロジェクト内の link がプロジェクト外の実体を指していれば整形しない", (t) => {
  const dir = createFixture(t);
  const proj = path.join(dir, "proj");
  installFakePrettier(proj, { prettier: "./bin/prettier.cjs" }, "bin/prettier.cjs");
  const file = writeFile(dir, "outside/src/a.ts", "const a = 1;\n");
  const link = path.join(proj, "linked");
  if (!linkDir(path.join(dir, "outside"), link)) return t.skip("link を作れない");

  assertSilent(format(proj, path.join(link, "src", "a.ts")));
  assert.equal(fs.readFileSync(file, "utf8"), "const a = 1;\n");
});
