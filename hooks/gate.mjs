#!/usr/bin/env node
/**
 * PreToolUse hook for Task / Agent: asks Jev (TypeSafe) whether a delegation to an ensemble
 * specialist is worth it, and in gate mode denies the ones the parent should do directly.
 *
 * - Opt-in: runs only when CLAUDE_ENSEMBLE_JEV is shadow / gate and TYPESAFE_API_KEY is set.
 * - Jev only returns probabilities. The allow / deny policy lives here.
 * - Only ensemble:* specialists are judged. Other subagent types pass through untouched.
 * - A prompt starting with "override:" passes without asking Jev. No counters, no state files.
 * - Fail open: any error, timeout or unexpected response exits 0 without output (= allow).
 * - The log (CLAUDE_ENSEMBLE_JEV_LOG) never contains the delegation prompt itself.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODEL = "jev-1.13.0"; // pinned: jev-latest moves on release and would shift the thresholds
const BASE_URL = "https://api.typesafe.ai/v1";
const BRIEF_LIMIT = 6000; // Jev accepts 32k tokens for state; keep the payload small
const BUDGET_MS = 3000; // hooks.json timeout is 10 s
const WORTH_BELOW = 0.25;
const DIRECT_ABOVE = 0.7;
const SPECIALISTS = new Set(["explore", "architect", "implementer", "test-runner", "reviewer"]);

const env = process.env;
const mode = (env.CLAUDE_ENSEMBLE_JEV ?? "").trim().toLowerCase();
const key = (env.TYPESAFE_API_KEY ?? "").trim();
if ((mode !== "shadow" && mode !== "gate") || !key) process.exit(0);

let input = {};
try {
  input = JSON.parse(fs.readFileSync(0, "utf8")) ?? {};
} catch {}

const toolInput = input?.tool_input ?? {};
const subagentType = typeof toolInput.subagent_type === "string" ? toolInput.subagent_type : "";
const name = subagentType.startsWith("ensemble:") ? subagentType.slice("ensemble:".length) : "";
if (!SPECIALISTS.has(name)) process.exit(0);

const prompt = typeof toolInput.prompt === "string" ? toolInput.prompt : "";

const logPath = (env.CLAUDE_ENSEMBLE_JEV_LOG ?? "").trim();
const record = {
  ts: new Date().toISOString(),
  session_id: typeof input.session_id === "string" ? input.session_id : null,
  subagent_type: subagentType,
  description: typeof toolInput.description === "string" ? toolInput.description : null,
  brief_chars: prompt.length,
  mode,
};

function log(fields) {
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, JSON.stringify({ ...record, ...fields }) + "\n");
  } catch {}
}

function finish(fields, output) {
  log(fields);
  if (output) process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

if (/^override:/i.test(prompt.trimStart())) finish({ decision: "override" });

// The agent's description is the single source of the delegation criteria.
function roleOf(agent) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  try {
    const text = fs.readFileSync(path.join(here, "..", "agents", `${agent}.md`), "utf8");
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
    return /^description:\s*(.+)$/m.exec(front)?.[1].trim() ?? "";
  } catch {
    return "";
  }
}

const role = roleOf(name);
if (!role) process.exit(0);

// https only, so the key never travels in clear text. Plain http is allowed for loopback (tests, local stubs).
function endpoint() {
  let url;
  try {
    url = new URL((env.CLAUDE_ENSEMBLE_JEV_BASE_URL ?? "").trim() || BASE_URL);
  } catch {
    return null;
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
  if (url.search || url.hash || url.username || url.password) return null;
  url.pathname = url.pathname.replace(/\/+$/, "") + "/systemone";
  return url.href;
}

const url = endpoint();
if (!url) finish({ decision: "error", error: "base_url" });

const stripCode = /^(1|true|on|yes)$/i.test((env.CLAUDE_ENSEMBLE_JEV_STRIP_CODE ?? "").trim());
// Replaces each fenced block (``` or ~~~, 3+ chars) with a marker. A fence closes only on the same
// character repeated at least as many times, as in CommonMark. An unclosed fence runs to the end.
function withoutCode(text) {
  const out = [];
  let fence = null;
  for (const line of text.split("\n")) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!fence) {
      if (m) {
        fence = m[1];
        out.push("[code omitted]");
      } else {
        out.push(line);
      }
    } else if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !line.slice(m[0].length).trim()) {
      fence = null;
    }
  }
  return out.join("\n");
}

const brief = (stripCode ? withoutCode(prompt) : prompt).slice(0, BRIEF_LIMIT);

const budget = Math.min(5000, Math.max(100, Number(env.CLAUDE_ENSEMBLE_JEV_BUDGET_MS) || BUDGET_MS));

const body = {
  model: (env.CLAUDE_ENSEMBLE_JEV_MODEL ?? "").trim() || MODEL,
  state: { specialist: name, role, delegation_brief: brief },
  questions: {
    worth: {
      type: "noul",
      instructions: "delegation_brief の作業を specialist に委譲する価値があるか",
      criteria: {
        true: "state.role が「使う」としている条件に、delegation_brief の作業が当たる",
        false: "state.role が「起動しない / 呼ばない / 委譲しない」としている場合に当たる、または使う条件のどれにも当たらない",
      },
    },
    direct: {
      type: "noul",
      instructions: "delegation_brief から読み取れる範囲で、委譲せず親エージェントが直接やる方が速く確実か",
      criteria: {
        true: "変更する場所と内容が具体的に書かれていて、作業が小さい",
        false: "広い調査、長い実行ログ、並列化、第三者の視点のいずれかが要る",
      },
    },
    size: {
      type: "score",
      instructions: "依頼された作業の規模",
      criteria: [
        "1ファイル内の明確な修正",
        "数ファイルの明確な変更",
        "調査や設計を伴う複数箇所の変更",
        "並列化できる大規模変更",
      ],
    },
  },
};

let res;
let data;
try {
  res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error", // a redirect would resend the brief (and the key) past the https / loopback check
    signal: AbortSignal.timeout(budget),
  });
  if (!res.ok) finish({ decision: "error", status: res.status });
  data = await res.json();
} catch (err) {
  finish({ decision: "error", error: err?.name === "TimeoutError" ? "timeout" : "fetch" });
}

const answers = data?.answers ?? {};
const worth = answers.worth?.noul;
const direct = answers.direct?.noul;
const size = Number.isFinite(answers.size?.score) ? answers.size.score : null;
const model = typeof data?.model === "string" ? data.model : null;
if (!Number.isFinite(worth) || !Number.isFinite(direct)) finish({ decision: "error", error: "answers", model });

const scores = { worth, direct, size, model };
if (!(worth < WORTH_BELOW && direct > DIRECT_ABOVE)) finish({ ...scores, decision: "allow" });
if (mode !== "gate") finish({ ...scores, decision: "would-deny" });

finish(
  { ...scores, decision: "deny" },
  {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `直接やる方が速く確実と判定した（worth=${worth.toFixed(2)}, direct=${direct.toFixed(2)}）。` +
        `${subagentType} の役割: ${role} ` +
        "それでも委譲が必要なら、prompt の先頭に `override: <理由>` と書いて再実行する。",
    },
  },
);
