#!/usr/bin/env node
/**
 * insane-test-guard — stage 1 CLI.
 *
 * Give it a test file. It sends the WHOLE file to Jev (TypeSafe System One), one
 * `noul` question per qawriter rule 1-6, and prints a JSON verdict. No extraction,
 * no "check only these blocks", no LLM. Keep it simple.
 *
 *   node cli.mjs <file> [--threshold 0.5] [--timeout 20000] [--pretty] [--no-llm]
 *
 * Stage 2: if Jev flags anything, a cheap low-reasoning LLM re-checks only the flagged
 * rules and says which are REAL, plus how to fix them. `--no-llm` skips that.
 *
 * Exit codes: 0 = reviewed (look at `verdict`) · 2 = could not review (nothing written).
 * Output on stdout is always the JSON object, so a caller can parse it.
 */

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { RULES } from './rules.mjs';

const ENDPOINT = 'https://openrouter.ai/api/v1/systemone';
const MODEL = 'jev-latest';
const MAX_BYTES = 120_000; // Jev's state cap is 32k tokens
const LLM_URL = 'https://openrouter.ai/api/v1/chat/completions';

const LANGUAGES = {
  '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.jsx': 'jsx',
  '.mjs': 'javascript', '.cjs': 'javascript', '.py': 'python', '.rb': 'ruby',
  '.go': 'go', '.rs': 'rust', '.sql': 'sql',
};

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--pretty') flags.pretty = true;
  else if (a.startsWith('--')) flags[a.slice(2)] = argv[++i];
  else positional.push(a);
}
const file = positional[0];
const threshold = Number(flags.threshold ?? 0.5);
const timeoutMs = Number(flags.timeout ?? 20_000);
const llmModel = process.env.ITG_LLM_MODEL || 'deepseek/deepseek-v4-flash';
const useLlm = !('no-llm' in flags);
const apiKey = process.env.OPENROUTER_API_KEY || openRouterKey();

const emit = (obj, code) => {
  process.stdout.write(`${JSON.stringify(obj, null, flags.pretty ? 2 : 0)}\n`);
  process.exit(code);
};

if (!file) emit({ verdict: 'error', error: 'usage: cli.mjs <file>' }, 2);

if (!apiKey) {
  emit(
    {
      file,
      verdict: 'error',
      error: `no OpenRouter key: set OPENROUTER_API_KEY or add openrouter.key to ${openRouterAuthFile()}`,
    },
    2,
  );
}

const languageOf = (f) => LANGUAGES[path.extname(f).toLowerCase()] ?? 'text';

// ── one Jev question ─────────────────────────────────────────────────────────
async function ask(rule, content, relPath, isDelta = false) {
  const body = {
    model: MODEL,
    state: {
      rule: {
        skill: 'qawriter',
        point: `${rule.id}. ${rule.title}`,
        severity: rule.severity,
        text: rule.text,
      },
      test_file: {
        path: isDelta ? `${relPath} (added lines only)` : relPath,
        language: languageOf(relPath),
        bytes: Buffer.byteLength(content),
        content,
      },
    },
    questions: {
      [`adheres_to_rule_${rule.id}`]: {
        type: 'noul',
        instructions: isDelta
          ? 'Does the added code in `test_file` adhere to `rule`?'
          : 'Does `test_file` adhere to `rule`?',
        criteria: rule.criteria,
      },
    },
  };

  const started = Date.now();
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const payload = await res.json();
  const score = payload.answers?.[`adheres_to_rule_${rule.id}`]?.noul;
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) {
    throw new Error(`bad noul for rule ${rule.id}: ${JSON.stringify(payload.answers)}`);
  }
  return { score, ms: Date.now() - started, usage: payload.usage ?? {} };
}

// ── stage 2: cheap LLM re-check, only for the rules Jev flagged ──────────────
function openRouterAuthFile() {
  return path.join(process.env.HOME ?? '/root', '.pi/agent/auth.json');
}

function openRouterKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    return JSON.parse(readFileSync(openRouterAuthFile(), 'utf8')).openrouter?.key;
  } catch {
    return undefined;
  }
}

async function askLlm(content, relPath, flagged) {
  const key = openRouterKey();
  if (!key) return { error: 'no openrouter key in ~/.pi/agent/auth.json' };

  const user = [
    `This file scored low on some qawriter rules. Say which are REALLY violated.`,
    '',
    ...flagged.map((f) => `- rule ${f.rule} (${f.title}) — score ${f.score}`),
    '',
    'For each flagged rule decide: really violated, or a false alarm?',
    'Answer with ONLY this JSON, no markdown:',
    '{"real":[{"rule":"<id>","line":<line number or 0>,"why":"<12 words max>"}],"fix":"<one sentence>","verdict":"ok|bad"}',
    '',
    `File ${relPath}:`,
    '```',
    content,
    '```',
  ].join('\n');

  const started = Date.now();

  // One retry: this call has been observed at ~2s and also blowing an 8s timeout,
  // depending on which provider OpenRouter routes the model to that minute. A retry
  // costs nothing when the first attempt is fast and rescues the verdict when it is not.
  const requestBody = JSON.stringify({
    model: llmModel,
    // Reasoning is DISABLED, not merely turned down to "low". Measured on this repo: with
    // `effort: "low"` a deepseek reasoning flash model still spends 1300+ reasoning
    // tokens, taking 12-22s, and sometimes eats the entire max_tokens budget so the reply
    // comes back with content: null. Disabled, it answers in ~2s and never burns budget.
    reasoning: { enabled: false },
    temperature: 0,
    max_tokens: 500, // the JSON answer is ~120 tokens; the cap bounds worst-case latency
    messages: [
      { role: 'system', content: 'You review test files for qawriter violations. Reply with compact JSON only.' },
      { role: 'user', content: user },
    ],
  });

  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(LLM_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: requestBody,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const payload = await res.json();
      const text = payload.choices?.[0]?.message?.content ?? '';
      const s = text.indexOf('{');
      const e = text.lastIndexOf('}');
      if (s === -1 || e === -1) throw new Error(`no JSON in reply: ${text.slice(0, 200)}`);
      return { ...JSON.parse(text.slice(s, e + 1)), model: llmModel, ms: Date.now() - started, usage: payload.usage ?? {} };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

// ── main ─────────────────────────────────────────────────────────────────────
const startedAll = Date.now();
let content;
let bytes;
try {
  bytes = statSync(file).size;
  if (bytes > MAX_BYTES) emit({ file, verdict: 'skipped', reason: `too big (${bytes} > ${MAX_BYTES})` }, 0);
  content = readFileSync(file, 'utf8');
} catch (error) {
  emit({ file, verdict: 'error', error: `cannot read: ${error.message}` }, 2);
}

let delta;
if (flags.delta) {
  try {
    delta = readFileSync(flags.delta, 'utf8');
  } catch {
    delta = undefined;
  }
}

const scores = {};
const timings = {};
const tokens = { input: 0, output: 0 };
try {
  for (const rule of RULES) {
    const isDelta = rule.scope === 'delta' && Boolean(delta);
    const r = await ask(rule, isDelta ? delta : content, file, isDelta);
    scores[rule.id] = r.score;
    timings[rule.id] = r.ms;
    tokens.input += r.usage.input_tokens ?? r.usage.prompt_tokens ?? 0;
    tokens.output += r.usage.output_tokens ?? r.usage.completion_tokens ?? 0;
  }
} catch (error) {
  emit({ file, verdict: 'error', error: error.message, scores, ms: Date.now() - startedAll }, 2);
}

const flagged = RULES.filter((r) => scores[r.id] < threshold).map((r) => ({
  rule: r.id,
  severity: r.severity,
  title: r.title,
  score: scores[r.id],
  scope: r.scope === 'delta' ? (delta ? 'delta' : 'file') : 'file',
}));

// Stage 2 — only pay for the LLM when Jev actually flagged something.
let review;
if (flagged.length && useLlm) {
  try {
    review = await askLlm(content, file, flagged);
  } catch (error) {
    review = { error: error.message };
  }
}

const verdict = flagged.length && review?.verdict !== 'ok' ? 'flagged' : 'ok';

emit(
  {
    file,
    bytes,
    verdict,
    threshold,
    worst: Math.min(...Object.values(scores)),
    scores,
    flagged,
    review,
    delta_bytes: delta ? Buffer.byteLength(delta) : 0,
    tokens,
    jev_ms: Object.values(timings).reduce((a, b) => a + b, 0),
    ms: Date.now() - startedAll,
  },
  0,
);
