# insane-test-guard

A pi CLI extension that stops pi from writing **insane tests**.

After pi writes or edits a test file, the guard asks **Jev** (TypeSafe System One) whether
the file follows the six [qawriter](../../../../wander-tools/skills/qawriter/SKILL.md)
test-integrity rules, **plus** one local rule (`delta-behavior`) that covers only the lines
the change added. If Jev flags anything, a cheap flash model re-checks only the flagged
rules and says which are **real** and how to fix them. The verdict is appended to the tool
result, so the model reads it and fixes the file itself.

```
pi writes pricing.spec.ts
  └─ file lands on disk
     └─ guard runs  (the turn waits here)
        ├─ Jev: rules 1-6 on the whole file, delta-behavior on the new lines   ~2.3 s
        └─ if flagged: flash model says which are real   ~2-6 s
     └─ verdict appended to the write's tool result
        └─ model reads it and fixes the test
```

## Files

| file | what |
|------|------|
| `insane-test-guard.ts` | the extension (lives one level up, symlinked into `~/.pi/agent/extensions/`) |
| `cli.mjs` | the reviewer: file → Jev → optional LLM → JSON verdict. Runnable on its own |
| `rules.mjs` | qawriter rules 1-6, generated verbatim from `jev-qawriter-audit.mjs`, plus the local `delta-behavior` rule. Regenerating from the skill drops `delta-behavior`: keep it |

## Use the CLI on its own

```bash
node cli.mjs path/to/thing.spec.ts --pretty
node cli.mjs path/to/thing.spec.ts --no-llm      # Jev only, ~2 s
node cli.mjs path/to/thing.spec.ts --delta /tmp/added-lines.ts   # delta-behavior sees the fragment
```

It prints JSON and always exits 0 when it reviewed the file; exit 2 means it could not
review (missing file, bad key) and nothing was written.

```json
{
  "verdict": "flagged",
  "worst": 0.03,
  "scores": { "1": 0.03, "2": 0.03, "3": 0.12, "4": 0.19, "5": 0.79, "6": 0.81 },
  "flagged": [{ "rule": "1", "severity": 10, "title": "Run the code...", "score": 0.03 }],
  "review": {
    "real": [{ "rule": "1", "line": 6, "why": "Reads source file instead of running code" }],
    "fix": "Import and test the discountPrice function directly instead of regex-matching source text.",
    "verdict": "bad"
  }
}
```

## Design decisions (each one measured, not guessed)

- **`delta-behavior` is scoped to the added lines.** Rules 1-6 send the whole file, so a
  weak new test hides among good ones. `delta-behavior` asks one question about the added
  lines only: does each new assertion cover a value the production code computes at run
  time? Measured on one real case: a shape-only assertion (reads a generated OpenAPI
  document) scored **0.04** and was flagged, while rules 1-6 all scored 0.81-0.94 and
  stayed quiet. A runtime assertion of the same feature scored **0.92**. Without `--delta`
  the rule falls back to the whole file and reports `scope: "file"`, so a manual run is
  honest about what it did not scope.
- **`tool_result`, not `tool_call`.** The file is meant to land; the handler is awaited, so
  the turn waits for the review, and the result is mutable, so the verdict rides back in the
  same tool result. No blocking, so there is no stuck-agent failure mode.
- **The whole file goes to Jev.** No `it` block extraction and no "check only cases 3,5,10".
  A block is not always `it` — it can be `test`, `fit`, `specify`, or a helper — so anything
  that cuts on `it(` is wrong by construction. Accepted cost: a pre-existing problem in an
  untouched part of the file also shows up in the verdict.
- **Rules 1-6 only.** Rule 7 ("prove it the direct way") is a manual judgement by design and
  is never screened.
- **Reasoning is disabled, not "low".** With `effort: "low"` the flash model still spends
  1300+ reasoning tokens: 12-22 s per call, and sometimes it eats the whole `max_tokens`
  budget so the reply comes back with `content: null`. Disabled, it answers in ~2 s.
  One bounded retry covers the remaining provider-routing variance.
- **Fail-open, always.** The write already happened. On any error, timeout, or odd output
  the guard returns nothing and the tool result passes through untouched.
- **Never verify with a database.** The verdict is test-file quality, nothing else.

## Cost and time (measured on this box)

| | |
|---|---|
| Jev, rules 1-6 on the whole file | ~1.9 s, ~4.4-4.9 k input tokens |
| Jev, `delta-behavior` on the added lines | ~0.4 s (the fragment is usually ~100 bytes) |
| flash model, only when flagged | ~1.5-6.5 s |
| **a clean file** | **~2.3 s added** |
| **a flagged file** | **~4-9 s added** |
| hard ceiling | 20 s, then fail-open |
| a non-test file | 0 s, not touched |

The model's *reaction* to a verdict can cost much more than the guard: in an A/B of the same
prompt, the guard itself fired once, and the extra wall time came from pi deliberating over
the finding. That is the point of the tool, but it is not free.

## Turning it off

```
/insane-test-guard off      # stop guarding
/insane-test-guard on       # start again
/insane-test-guard status   # what is it now?
```

The setting is written to `~/.pi/agent/insane-test-guard.state`, and the file is read on
**every** check. So it applies to:

| scope | affected? |
|---|---|
| the session you typed it in | yes, immediately — no restart |
| a pi session you start later | yes — it reads the same file |
| a nested / child pi process | yes — same file |
| `INSANE_TEST_GUARD=0` in the env | forces off, overrides everything |

If no state file exists, the guard is **on** by default.

## Settings

| | |
|---|---|
| `INSANE_TEST_GUARD=0` | force the guard off, overrides the state file |
| `ITG_LLM_MODEL` | override the second-opinion model (default `deepseek/deepseek-v4-flash`) |
| `OPENROUTER_API_KEY` | override the key from `~/.pi/agent/auth.json` |
| `--timeout <ms>` | per-request timeout for the CLI (extension passes 8000) |

Jev and the second-opinion model are both served by OpenRouter, on one key: the
`OPENROUTER_API_KEY` env var if it is set, otherwise `~/.pi/agent/auth.json` →
`openrouter.key`. A missing key exits 2 with a clear message.

## What it does not do
- Does not look at files written by `bash` (`cat > x.spec.ts`, `sed -i`). Only the `write`
  and `edit` tools are watched.
- Does not block anything, ever. It reports; the model decides.
- Does not review source files, only test files.

## How it was tested

Toggle and scope (RPC-driven, one process):

| case | result |
|------|--------|
| write while on | guard fires (rule 1, score 0.02) |
| `/insane-test-guard off`, write again | **silent** — mid-session, no restart |
| `/insane-test-guard off`, then a *new* pi process writes | **silent** — the setting is global |
| `/insane-test-guard on`, then a *new* pi process writes | fires again |

Gotcha found while testing: feeding `pi --mode rpc` a prompt at t=0 can beat extension
loading, and the guard will not fire for that first write. Wait ~10 s after startup before
sending the first RPC prompt. Interactive use cannot hit this — you cannot type before the
prompt appears.

Seven real pi sessions in `tmux` session `SKILLS`, window `insane-guard`:

| case | result |
|------|--------|
| pi writes a naturally good test | silent (correct — CLI scored it 0.95+) |
| pi writes a rule-1 test (reads source, regex) | flagged, rule 1 `REAL at line 1` |
| `edit` makes an existing test violate rule 1 | flagged — edit coverage confirmed |
| pi writes a rule-3 test (mocks the thing under test) | flagged, and **pi rewrote the mock to spy on the real function**, asserting the real result `135` as well as the call args |
| pi writes `notes.md` | silent, 0 s |
| `INSANE_TEST_GUARD=0` | silent |
| file over 120 000 bytes | `skipped`, guard silent |
| bad API key / missing file | exit 2, guard silent (fail-open) |

Test-file detection is checked against 12 path shapes, including `__tests__/`, `_test.go`,
and negative cases like `src/pricing.ts` and `README.md`.
