/**
 * insane-test-guard
 *
 * After pi writes or edits a TEST file, ask Jev (TypeSafe System One) whether the file
 * follows the qawriter rules 1-6. If Jev flags anything, a cheap flash model re-checks
 * only the flagged rules and says which are REAL and how to fix them. The verdict is
 * appended to the tool result, so the model sees it and can fix the file itself.
 *
 * Why `tool_result` and not `tool_call`: the file has already landed on disk (that is
 * what we want), the handler is awaited so the turn waits for the review, and the
 * result is mutable, so the verdict rides back to the model in the same tool result.
 *
 * Fail-open, always: the write already happened. On any error, timeout or odd output
 * we return nothing and the tool result passes through untouched.
 *
 * Rules 1-6 cover the whole file. `delta-behavior` covers only the lines the write/edit
 * adds, so old contract tests in the same file stay quiet.
 *
 * Kill switch: INSANE_TEST_GUARD=0
 *
 * Toggle: `/insane-test-guard off` / `on` / `status`. The setting is written to
 * `~/.pi/agent/insane-test-guard.state`, so it applies to EVERY pi process — this
 * session, a new session, and any nested/child pi process — not just this one.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const run = promisify(execFile);

const HOME_CLI = join(homedir(), ".pi", "agent", "extensions", "insane-test-guard", "cli.mjs");
const REPO_CLI = "/home/yu/my/tmux/config/pi/.pi/agent/extensions/insane-test-guard/cli.mjs";

// Where is cli.mjs? Try: explicit override, then next to this file, then the installed
// location. `realpathSync` matters because $HOME/.pi/agent/extensions/insane-test-guard.ts is
// a SYMLINK into the repo, so the path pi loaded it from is not where cli.mjs lives.
function findCli(): string {
	const beside = (self: string | undefined) => (self ? join(dirname(self), "insane-test-guard", "cli.mjs") : undefined);
	const raw = fileURLToPath(import.meta.url);
	let real: string | undefined;
	try {
		real = realpathSync(raw);
	} catch {
		real = undefined;
	}
	const candidates = [process.env.ITG_CLI, beside(real), beside(raw), HOME_CLI, REPO_CLI];
	return candidates.find((p) => p && existsSync(p)) ?? REPO_CLI;
}

const CLI = findCli();
const STATE_FILE = join(homedir(), ".pi", "agent", "insane-test-guard.state");
const AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");

// Jev and the second-opinion model both run on OpenRouter, so one missing key stops
// every request. That is worth a loud notice: silence would look like "tests are fine".
function hasOpenRouterKey(): boolean {
	if (process.env.OPENROUTER_API_KEY) return true;
	try {
		return Boolean(JSON.parse(readFileSync(AUTH_FILE, "utf8")).openrouter?.key);
	} catch {
		return false;
	}
}

// Read the state file on every check rather than caching it, so `/insane-test-guard off`
// in one pi takes effect in the others immediately. It is a tiny file.
function isEnabled(): boolean {
	if (process.env.INSANE_TEST_GUARD === "0") return false; // hard kill switch
	try {
		return readFileSync(STATE_FILE, "utf8").trim() !== "off";
	} catch {
		return true; // no state file yet: on by default
	}
}

function setEnabled(on: boolean): void {
	mkdirSync(dirname(STATE_FILE), { recursive: true });
	writeFileSync(STATE_FILE, on ? "on\n" : "off\n");
}
// A test file by name: foo.test.ts / foo.spec.ts / anything under __tests__/ / foo_test.go.
// Naming varies (the same reason the review is whole-file and never cuts on `it(`), so this
// is deliberately a little broader than `.test.`/`.spec.` alone.
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|_test\.(py|go|rb)$|(^|\/)__tests__\//;
const HARD_TIMEOUT_MS = 20_000; // absolute: the whole review, then give up (fail-open)
const PER_REQUEST_MS = 8_000; // each Jev / LLM request inside the CLI
const MAX_DELTA_BYTES = 60_000; // bounds the tokens rule 7 can send

type Report = {
	verdict?: string;
	worst?: number;
	flagged?: { rule: string; severity: number; title: string; score: number; scope?: string }[];
	review?: { verdict?: string; real?: { rule: string; line?: number; why?: string }[]; fix?: string; error?: string };
};

// What this write/edit added: `edits[].newText` for an edit, the whole `content` for a
// write. Rules with scope 'delta' are screened against this, not the whole file, so a
// pre-existing shape assertion elsewhere in the file cannot be blamed on this change.
function addedLinesOf(toolName: string, input: unknown): string {
	const i = (input ?? {}) as { content?: unknown; edits?: { newText?: unknown }[] };
	if (toolName === "write") return typeof i.content === "string" ? i.content : "";
	const edits = Array.isArray(i.edits) ? i.edits : [];
	return edits
		.map((e) => (typeof e?.newText === "string" ? e.newText : ""))
		.filter((t) => t.trim() !== "")
		.join("\n\n");
}

export default function (pi: ExtensionAPI) {
	// A missing cli.mjs used to fail SILENTLY (every review just returned nothing, which looks
	// exactly like a clean test file). Say it out loud once instead.
	pi.on("session_start", (_event, ctx) => {
		if (!existsSync(CLI)) {
			const msg = `insane-test-guard: cli.mjs not found at ${CLI} — the guard is NOT reviewing anything`;
			if (ctx.hasUI) ctx.ui.notify(msg, "error");
			return;
		}
		if (!hasOpenRouterKey()) {
			const msg = `insane-test-guard: no OpenRouter key in OPENROUTER_API_KEY or ${AUTH_FILE} — the guard is NOT reviewing anything`;
			if (ctx.hasUI) ctx.ui.notify(msg, "error");
		}
	});

	pi.registerCommand("insane-test-guard", {
		description: "Turn the test-quality guard on/off (on | off | status)",
		getArgumentCompletions: (prefix) =>
			["on", "off", "status"]
				.filter((w) => w.startsWith(prefix))
				.map((w) => ({ value: w, label: w })),
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "off") {
				setEnabled(false);
				ctx.ui.notify(`${STATE_FILE} = off — all pi sessions will skip the guard`, "warning");
				return;
			}
			if (arg === "on") {
				setEnabled(true);
				ctx.ui.notify("insane-test-guard: ON for all pi sessions", "info");
				return;
			}
			const env = process.env.INSANE_TEST_GUARD === "0" ? " (forced off by INSANE_TEST_GUARD=0)" : "";
			ctx.ui.notify(`insane-test-guard is ${isEnabled() ? "ON" : "OFF"}${env}`, "info");
		},
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!isEnabled()) return;

		if (event.toolName !== "write" && event.toolName !== "edit") return;
		const path = event.input.path;
		if (typeof path !== "string" || !TEST_FILE.test(path)) return;
		if (event.isError) return;

		const delta = addedLinesOf(event.toolName, event.input).slice(0, MAX_DELTA_BYTES);
		const deltaFile = delta.trim() ? join(tmpdir(), `itg-delta-${process.pid}-${Date.now()}.txt`) : undefined;
		if (deltaFile) writeFileSync(deltaFile, delta);

		let report: Report;
		try {
			const args = [CLI, path, "--timeout", String(PER_REQUEST_MS)];
			if (deltaFile) args.push("--delta", deltaFile);
			const { stdout } = await run(process.execPath, args, {
				timeout: HARD_TIMEOUT_MS,
				maxBuffer: 8 * 1024 * 1024,
			});
			report = JSON.parse(stdout) as Report;
		} catch {
			return; // fail-open: timeout, crash, unparseable — say nothing
		} finally {
			if (deltaFile) {
				try {
					unlinkSync(deltaFile);
				} catch { /* the file is in tmp; leaving it is harmless */ }
			}
		}

		if (report?.verdict !== "flagged" || !report.flagged?.length) return;

		const real = new Map((report.review?.real ?? []).map((r) => [String(r.rule), r]));
		const lines = [
			"",
			`[insane-test-guard] qawriter rules 1-6 + delta-behavior, worst score ${report.worst}`,
			...report.flagged.map((f) => {
				const where = f.scope === "delta" ? " on the added lines" : "";
				const hit = real.get(f.rule) ?? real.get(`rule ${f.rule}`);
				return hit
					? `  rule ${f.rule} (sev ${f.severity}) score ${f.score}${where} — REAL${hit.line ? ` at line ${hit.line}` : ""}: ${hit.why ?? ""}`
					: `  rule ${f.rule} (sev ${f.severity}) score ${f.score}${where} — ${f.title}`;
			}),
		];
		if (report.review?.fix) lines.push(`  fix: ${report.review.fix}`);
		if (report.review?.error) lines.push(`  (no second opinion: ${report.review.error})`);
		lines.push("  Fix the test, or say why the flagged rule does not apply.");

		if (ctx.hasUI) ctx.ui.notify(`insane-test-guard: ${report.flagged.length} qawriter finding(s)`, "warning");

		return {
			content: [...event.content, { type: "text" as const, text: lines.join("\n") }],
		};
	});
}
