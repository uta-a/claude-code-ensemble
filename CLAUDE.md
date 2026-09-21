# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 概要

Claude Code 用の plugin「ensemble」。subagent（`agents/*.md`）と hook（`hooks/*.mjs`）だけで構成され、ビルド工程も npm 依存も無い。リポジトリ自体が単一プラグインの marketplace（`uta-a-ensemble`）を兼ねる。

## コマンド

```
node --test                                        # 全テスト（node:test のみ）
node --test tests/check.test.mjs                   # 1ファイル
node --test --test-name-pattern="<名前の一部>"      # 1テスト
claude --plugin-dir .                              # インストールせずに plugin を読み込んで試す
```

package.json は無い。lint / build も無い。check.mjs のテストは git が無いと skip される。

## 構成

- `hooks/hooks.json` が3つの hook を `${CLAUDE_PLUGIN_ROOT}` 基準で登録する。各 hook は stdin の JSON を読み、stdout に出力する単独の Node スクリプト
  - `remind.mjs`（UserPromptSubmit）: 毎ターン委譲の指針をプロンプトに足す
  - `format.mjs`（PostToolUse `Edit|Write`）: project-local の Prettier を `node` で直接実行する
  - `check.mjs`（Stop）: git 差分に lint 対象ファイルがあるときだけ `lint` script を実行し、失敗時に1回 block する
- specialist を増減したら README の表、`CLAUDE.md.section.md`、`remind.mjs` の文面もあわせて更新する
- `CLAUDE.md.section.md` は利用者が自分の CLAUDE.md に手動で追記するための配布物。このリポジトリの CLAUDE.md ではない
- バージョンは `.claude-plugin/plugin.json` の `version` で管理する

## hook を書くときの不変条件

- フェイルオープン: 入力の破損、外部コマンドの失敗、時間切れでは何も出力せず exit 0。hook の障害で利用者の作業を止めない
- 状態を持たない: 状態ファイル、カウンター、モード切り替えを追加しない（README の設計方針）
- 各 hook の内部 budget は `hooks.json` の timeout より短く保つ（check.mjs は 75 秒 / 90 秒）
- 環境変数は `CLAUDE_ENSEMBLE_*` に揃え、無効化は `0` / `false` / `off` / `no` を受け付ける
- Windows も対象（パス解決、symlink / junction、プロセスツリーの終了）。テストもそれを前提に書かれている
- hook 内のコメントは英語、README・テスト名・agent の本文は日本語

## テスト

- hook は `tests/helpers.mjs` の `runHook` で子プロセスとして起動し、stdin に JSON を渡す
- fixture は `createFixture(t)` で os.tmpdir() 配下に作る。後始末は t.after で自動
- 開発者の `CLAUDE_ENSEMBLE_*` がテストに漏れないよう、環境変数は `cleanEnv()` 経由で渡す
- 挙動を変えたら README の該当節（環境変数の表、hook ごとの仕様）も更新する。README が仕様書を兼ねている
