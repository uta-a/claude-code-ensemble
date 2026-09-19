# ensemble

Claude Code で必要な specialist だけを必要なときに呼ぶ、adaptive specialist ensemble の最小構成。
固定の工程や planner を通すのではなく、親エージェントがタスクの性質を見て explore / architect / implementer / test-runner / reviewer を選ぶ。委譲そのものをワークフロー化せず、直接やる方が速く確実なら直接やる。

## 設計方針

ensemble が最適化するのは「エージェント数」ではなく、専門化による文脈分離と検証コストの配置。

| specialist | 起動する条件 | 起動しない例 |
| :-- | :-- | :-- |
| explore | 既存実装や呼び出し関係を知らず、変更前に事実確認が必要。往復の多い調査を結論だけに圧縮したい | 場所の見当がつく検索、変更ファイルが多いだけ |
| architect | API、schema、module boundary、依存関係など将来コストの高い設計判断がある | 既存パターンに沿う実装、機械的変更 |
| implementer | 独立実装の並列化、または機械的変更を親の文脈から隔離したい | 1〜2ファイル程度の明確な変更 |
| test-runner | test / build / 全体 typecheck など重い検証を集約したい | 変更箇所だけの小さな検証 |
| reviewer | 非自明なロジック、状態、エラー処理、公開 API を第三者視点で見る価値がある | 文言・スタイル変更 |

「迷ったら委譲しない」「委譲は手段であって工程ではない」を基本にする。state machine、強制 planner、agent counter は持たない。

意図的に持たない役割もある。外部ドキュメントの調査と、原因不明の失敗の調査は、親エージェントが直接行うか、Claude Code の組み込みエージェントに任せる。explore は Web にアクセスするツールを持たない。リポジトリを読めるエージェントに外部コンテンツを読ませると、読んだ内容に誘導されてファイルの中身を外へ送る経路ができるため、役割を分けている。

## インストール

plugin として導入する。`~/.claude/` へ agents や hooks を手動でコピーする必要はない。
hook は `hooks/hooks.json` で `${CLAUDE_PLUGIN_ROOT}` 基準に登録される。エージェントは `ensemble:explore` のように名前空間付きで提供されるので、`~/.claude/agents/` にある同名エージェントや他の plugin のエージェントを上書きしない。
以前 `~/.claude/` に手動で配置していた場合は、`~/.claude/settings.json` にある format.mjs / check.mjs の hooks 登録、`~/.claude/hooks/` の該当ファイル、`~/.claude/agents/` にコピーした ensemble のエージェントを削除する。残したままだと hook が二重に走る。

### 前提条件

- Node.js が PATH にあること（hook は `node` で実行される）
- Claude Code v2.1.271 以降。explore / test-runner は frontmatter の `omitClaudeMd` を使う。古い版では無言で無視され、この2つにも CLAUDE.md が渡る
- Stop hook は git 管理下のプロジェクトでのみ働く。非 git のプロジェクトでは何もしない

### 手順

このリポジトリ自体が単一プラグインの marketplace（`uta-a-ensemble`）になっている。

```
/plugin marketplace add uta-a/claude-code-ensemble
/plugin install ensemble@uta-a-ensemble
```

インストールせずに試すだけなら、clone したディレクトリを直接読み込める。

```
claude --plugin-dir /path/to/claude-code-ensemble
```

clone したディレクトリをローカル marketplace として登録することもできる。その場合は `/plugin marketplace add /path/to/claude-code-ensemble` にする。

### CLAUDE.md への追記（任意）

`CLAUDE.md.section.md` は plugin では自動適用されない。使う場合は、個人用（`~/.claude/CLAUDE.md`）またはプロジェクトの CLAUDE.md に手動で追記する。
追記する前に、既存の CLAUDE.md の記述（委譲やコミットのルールなど）と矛盾しないか確認する。

### アンインストール

```
/plugin uninstall ensemble@uta-a-ensemble
/plugin marketplace remove uta-a-ensemble
```

一時的に止めたいだけなら `/plugin disable ensemble@uta-a-ensemble` で無効化する。
CLAUDE.md に追記した節は自動では消えないので、手動で削除する。

## 明示的に始める: /ensemble:run

普段は Claude が自分で委譲するかどうかを決める。委譲を寄せたいときは、ユーザーが明示的に始められる。

```
/ensemble:run 認証まわりを新しいセッション管理に置き換える
/ensemble:run
```

- タスクを渡すと、独立したタスクに分け、それぞれを specialist に任せるか本体が直接やるかをその場で決め、分担を短く示してから着手する
- 引数なしで呼ぶと、この会話の残りの作業を整理し直し、以降の調査や長い出力を伴う作業を specialist に寄せる。長い会話で委譲が弱まってきたと感じたときに使う
- 固定の工程（計画 → 実装 → 検証 → レビュー）は回さない。効くのはその依頼1回分だけで、モードとして持ち越さない
- ユーザー専用。Claude が自分から呼ぶことはない（`disable-model-invocation: true`）

## モデル

- architect: opus
- explore: sonnet
- implementer / reviewer: inherit（親のモデルを引き継ぐ。文脈分離が目的で、能力は落とさない）
- test-runner: sonnet + `effort: low`（ログの圧縮だけでなく root cause の特定まで担うため）

frontmatter の `model` で固定している。変えたい場合は `agents/*.md` を編集する。

## Stop hook: hooks/check.mjs

Stop hook が実行するのは lint だけ。repo が dirty かどうかだけでは決めず、実際に変更されたファイル種別が lint に関係するときだけ実行する。

- 検査対象は作業ツリー全体の git 差分（staged / unstaged / untracked）。セッション開始前からある未コミット変更も含まれる。セッション単位への絞り込みはしない（Bash やサブエージェントによる変更を取りこぼさないため）。代わりに block の文面で、このセッションで触っていないファイルのエラーは直さず報告するよう指示する
- 非 git のプロジェクトでは何もしない
- Markdown、README、docs/ などドキュメントだけの変更: lint を実行しない
- lint 対象になりやすいソース・設定ファイルの変更: `lint` script があれば実行する
- test / build / typecheck は Stop hook では回さない。全体 typecheck を含む重い検証は test-runner に集約する
- 検査には 75 秒の内部 budget を使う
- `hooks/hooks.json` 側の hook timeout は 90 秒で、内部 budget より長くしてある
- `CLAUDE_ENSEMBLE_CHECK_BUDGET_MS` で内部 budget を変更できる。値は 1〜80 秒の範囲に丸められる（git の実行とプロセスツリーの終了を含めて hook timeout の 90 秒未満に収めるため）
- 時間切れ、または出力が上限（8MB）を超えたときは lint のプロセスツリーごと終了させる
- package manager が PATH に無い、script が無い、lint script の先頭コマンドが `node_modules/.bin`（上位ディレクトリ含む）にも PATH にも無い、起動不能、時間切れ、出力上限超過、シグナル終了の場合は block せず、何も通知しない
- 先頭コマンドの不在判定は、shell 組み込みコマンドで始まる script、パスや引用符を含む先頭トークン、Yarn PnP のプロジェクトでは行わず、そのまま実行する
- 既知の制限: 判定するのは先頭コマンドだけ。`cross-env` のような多段 script で後段のツールが無い場合、Windows では block され得る
- lint が失敗したときだけ、重要なエラー行を最大 20 行に圧縮して 1 回 block する
- lint の出力が文字化けしている（UTF-8 でない）場合は、block 理由にコマンド名と exit code だけを載せる

## PostToolUse hook: hooks/format.mjs

Edit / Write された対象ファイルに対し、project-local の `prettier` パッケージを `node` で直接実行する。`npx` は使わず、ダウンロードもしない。

- 編集ファイルに最も近い project-local Prettier を優先する
- 対象は Prettier が扱うコード・設定・Markdown 系の拡張子。Stop hook が lint するコードの拡張子（`.vue` `.svelte` `.mts` `.cts` を含む）はすべて含む。`.svelte` は prettier-plugin-svelte が無ければ何も起きない
- プロジェクト（cwd）の外にあるファイルは整形しない。内外の判定は symlink / junction / 8.3 短縮名を解決した実パスで行うので、プロジェクト内の link が外部の実体を指している場合も整形しない
- 相対パスの `file_path` は cwd を基準に解決する
- project-local の Prettier が見つからなければ、何もせずスキップする
- 対象外拡張子や formatter 失敗も hook 全体を止めない
- `CLAUDE_ENSEMBLE_FORMAT=0`（`false` / `off` / `no` も可）で無効化できる

## specialist の検証分担

implementer は実装と、その変更に直接対応する最小限の検証までを担当する。対象テスト、単一パッケージ、変更ファイル単位の lint などを優先し、全体 test / build / typecheck は原則として実行しない。

test-runner は重い検証をまとめて引き受ける。成功時は command・exit code・pass の事実だけに圧縮し、失敗時は root cause・exit code・重要なエラー箇所だけ返す。

reviewer は `blocker / warning / suggestion` の3件数を必ず先頭に出し、実在する指摘だけを列挙する。件数を埋めるための指摘は作らない。

## テスト

hook の再現テストは npm 依存なし（Node.js 標準の node:test のみ）で書いてある。
Stop hook のテストには git が必要。無ければ該当テストは skip される。

```
node --test
```

## orchestra との関係

ensemble は orchestra の縮小版ではない。目的は固定オーケストレーションを小さく再現することではなく、必要な専門性だけを適応的に呼び出すことにある。

orchestra と併用はできるが、設計思想は別物として扱う。エージェントは `ensemble:` の名前空間付きになるので、orchestra やユーザー定義のエージェントを上書きすることはない。ただし implementer、reviewer など同種のエージェントと役割が重なり、どれが呼ばれるかが曖昧になる。併用するなら片方を無効化しておくのが無難。
