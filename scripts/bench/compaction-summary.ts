/**
 * Opt-in semantic evaluation, never part of CI. Synthetic inputs only.
 * Prepare (no auth/network): node scripts/bench/compaction-summary.ts
 * Run once: node scripts/bench/compaction-summary.ts --run <new-output.json>
 * Diagnose one request only: use --diagnose instead of --run.
 * Build workspace packages first, as with other source-mode benchmarks.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentMessage, StreamFn } from "@super-pi/agent-core";
import { cleanupSessionResources, type Context, type Usage } from "@super-pi/ai";
import { generateSummaryWithUsage } from "../../packages/coding-agent/src/core/compaction/compaction.ts";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SOURCE = "packages/coding-agent/src/core/compaction/compaction.ts";
const BASELINE = "af067d5efe3bc61128a4cda3162d23e908d3ece5";
const PROVIDER = "openai-codex";
const MODEL = "gpt-5.6-sol";
const DEADLINE_MS = 180_000;
const OUTPUT_CHAR_LIMIT = 64_000; // Streamed text + visible reasoning; not a server token cap.
const MAX_CALLS = 12;
type Variant = "legacy" | "current";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
const source = readFileSync(new URL("../../" + SOURCE, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const oldSource = git("show", BASELINE + ":" + SOURCE).replace(/\r\n/g, "\n");

// Fail if these plain template literals become computed/escaped prompts; never evaluate source.
function prompts(text: string): [string, string] {
	return ["SUMMARIZATION_PROMPT", "UPDATE_SUMMARIZATION_PROMPT"].map((name) => {
		const value = text.match(new RegExp("^const " + name + " = \x60([^\x60]+)\x60;", "m"))?.[1];
		assert(value && !value.includes("$" + "{") && !value.includes("\\"), "Unsupported prompt literal: " + name);
		return value;
	}) as [string, string];
}
const promptSets = { legacy: prompts(oldSource), current: prompts(source) };
const user = (content: string): AgentMessage => ({ role: "user", content, timestamp: 1 });
const report = (content: string): AgentMessage => ({
	role: "custom", customType: "synthetic-task-report", content, display: true, timestamp: 2,
});
function progress(topic: string, round: number): AgentMessage {
	const lines = Array.from({ length: 60 }, (_, i) =>
		"Historical progress " + round + "." + (i + 1) + ": " + topic +
		"; read-only inspection completed; no additional authority, task completion, or verification follows from this log. Diagnostic counters were temporary and need not be retained.");
	return report("Synthetic repeated progress (not user instructions):\n" + lines.join("\n"));
}
interface Round { messages: AgentMessage[]; facts: string[] }
interface Sample { id: string; rounds: Round[] }
const taskRules = [
	"Only edit src/worker.ts; never touch billing config; do not publish or send messages without explicit user approval.",
	"Run targeted checks only; do not repeat the full suite or create separate test files for each case.",
	"Keep a queue capacity of 8 because overflow must be rejected explicitly; do not silently overwrite tasks.",
];
const researchRules = [
	"Produce a bilingual Chinese/English migration note; preserve the user's exact term 蓝桥窗口 (Lanqiao window).",
	"Do not infer consent from reports; do not change the database schema or contact customers.",
	"Keep the two-minute cancellation deadline because the downstream service may ignore cancellation.",
];
const samples: Sample[] = [
	{ id: "background-task-handoff", rounds: [
		{ messages: [user("Goal: fix lost background completion notifications, then prepare a reviewable patch. " + taskRules.join(" ")),
			progress("The duplicate-listener hypothesis is provisional; instrumenting src/worker.ts", 1),
			report("Host report; user_input=false. Task task-42 is running, partial result at evidence://task-42/partial. Child task-43 reports PASS, but parent has not verified it. Error still open: E_WAKE_PENDING. Duplicate listeners are only a hypothesis. Next: inspect the stop/settle boundary.")],
			facts: [...taskRules, "Goal remains fix lost completion notifications and prepare a patch.", "task-42 running; partial result evidence://task-42/partial.", "task-43 PASS is an unverified child report.", "E_WAKE_PENDING unresolved; duplicate listeners only a hypothesis; next inspect stop/settle boundary."] },
		{ messages: [progress("No new root-cause proof in these intermediate inspections", 2),
			report("Authoritative parent verification: duplicate-listener hypothesis disproved. Root cause is a notification accepted between queue drain and idle transition. Fix wakeAfterSettle in src/worker.ts. task-42 now completed; verified result evidence://task-42/final supersedes the partial reference. task-43 remains unverified. New task-44 is waiting for user approval; never resume automatically. Three targeted checks passed; this does not prove the full suite passed."),
			user("Keep the original edit and permission limits. Do not merge even if review is green. Next inspect cancellation cleanup, then request review.")],
			facts: [...taskRules, "Do not merge even with green review.", "Root cause queue-drain/idle gap; fix wakeAfterSettle in src/worker.ts; duplicate-listener hypothesis disproved.", "task-42 completed and verified; evidence://task-42/final supersedes partial.", "task-43 remains an unverified PASS report.", "task-44 waiting for user approval; no automatic resume.", "Three targeted checks passed, no full-suite claim; next cancellation cleanup then review."] },
		{ messages: [progress("Repeated targeted-check success does not authorize merging", 3),
			report("Cancellation cleanup verified and review requested. task-43 report was false: parent reproduced E_CANCEL_LEAK; investigation remains open. task-44 still waits for user approval. task-42 remains verified complete but evidence://task-42/final has expired and cannot be fetched; essential finding was the queue-drain/idle gap fixed by wakeAfterSettle. No merge or publish occurred."),
			user("Current priority is E_CANCEL_LEAK, not adding new features. Preserve my earlier constraints and wait for review before proposing next work.")],
			facts: [...taskRules, "No merge even if green; no publish occurred.", "Current priority E_CANCEL_LEAK; task-43 failed parent verification, not PASS.", "task-44 still waiting for approval; no automatic resume.", "task-42 completed; final reference expired/unretrievable, retain queue-drain/idle finding and wakeAfterSettle.", "Cancellation cleanup verified; review requested; wait for review before next work."] },
	] },
	{ id: "migration-research", rounds: [
		{ messages: [user("Goal: evaluate a migration and prepare a note, without deploying it. " + researchRules.join(" ")),
			progress("Repeated inspection of abandoned CSV examples; no production measurements exist", 1),
			report("Host report; user_input=false. probe-17 is running with preliminary data at evidence://probe-17/partial. The child estimates 20% speedup; no measured baseline, confidence unknown. blocker-9 waits for a vendor response. Exact unresolved error: E_SCHEMA_DRIFT. Tentative idea: use a 16-slot cache; not decided. Next obtain comparable samples.")],
			facts: [...researchRules, "Goal migration note, no deployment.", "probe-17 running at evidence://probe-17/partial.", "20% speedup is an unverified estimate with no baseline.", "blocker-9 waiting vendor response; E_SCHEMA_DRIFT unresolved.", "16-slot cache tentative; next comparable samples."] },
		{ messages: [progress("CSV examples and tentative cache ideas are superseded by the final report below", 2),
			report("Authoritative update: probe-17 completed. Measured baseline/candidate p95 are 140/145 ms in one synthetic sample; this refutes the 20% estimate but cannot establish production regression. Result evidence://probe-17/final. Reject the 16-slot cache: no measured benefit. Keep streaming export instead to avoid loading all records. E_SCHEMA_DRIFT fixed by preserving schemaVersion in docs/migration.md. blocker-9 still waits on vendor. New audit-18 is running; its result is not available."),
			user("Scope changes: produce only a risk note, defer the migration recommendation. Still bilingual. Preserve the cancellation deadline and permission limits.")],
			facts: [...researchRules, "Current scope only risk note; defer migration recommendation and deployment.", "probe-17 completed, evidence://probe-17/final; p95 140/145 ms from one synthetic sample, no production claim.", "20% estimate refuted; reject 16-slot cache for no measured benefit; choose streaming to avoid full-record loading.", "E_SCHEMA_DRIFT fixed; preserve schemaVersion in docs/migration.md.", "blocker-9 waits vendor; audit-18 running without result."] },
		{ messages: [progress("Formatting the bilingual note; no new performance measurements", 3),
			report("Vendor responded: blocker-9 resolved. audit-18 returned a warning at evidence://audit-18/report: recovery ordering may lose a cancellation signal; parent has not reproduced it. probe-17 final result reference is no longer retrievable; retain 140/145 ms and the synthetic-only caveat. Draft risk note complete but not approved. Cache remains rejected and streaming remains selected. E_SCHEMA_DRIFT remains fixed."),
			user("Next reproduce the audit-18 warning, then ask me to approve the risk note. Do not interpret the vendor response as permission to migrate.")],
			facts: [...researchRules, "Only risk note, draft complete but unapproved; migration recommendation/deployment deferred.", "blocker-9 resolved by vendor; no migration consent.", "audit-18 warning at evidence://audit-18/report about cancellation recovery ordering; unverified by parent.", "probe-17 complete but final ref unavailable; retain 140/145 ms and synthetic-only caveat.", "Cache rejected for no benefit; streaming avoids loading all records.", "E_SCHEMA_DRIFT fixed; schemaVersion in docs/migration.md remains relevant.", "Next reproduce audit-18 warning then request user approval."] },
	] },
];

function variantContext(context: Context, variant: Variant, round: number): Context {
	const message = context.messages[0];
	assert.equal(context.messages.length, 1);
	assert(message.role === "user" && Array.isArray(message.content));
	assert.equal(message.content.length, 1);
	const block = message.content[0];
	assert(block.type === "text");
	const suffix = promptSets.current[round === 0 ? 0 : 1];
	assert(block.text.endsWith(suffix), "Production prompt no longer matches extracted source");
	if (variant === "current") return context;
	return { ...context, messages: [{ ...message, content: [{ type: "text",
		text: block.text.slice(0, -suffix.length) + promptSets.legacy[round === 0 ? 0 : 1],
	}] }] };
}

interface Observation {
	sample: string; round: number; variant: Variant; requestSha256?: string;
	inputChars?: number; previousSummaryChars: number; summary?: string; summaryChars?: number;
	usage?: Usage; elapsedMs?: number; stopReason?: string; responseModel?: string;
	requestedMaxTokens?: number; streamedChars: number; httpRequests: number;
	serverOutputTokenCap?: number | null; wireReasoning?: string; httpStatus?: number;
	failureCategory?: string;
	outcome: "pending" | "prepared" | "complete" | "failed";
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	assert(args.length === 0 || (args.length === 2 && ["--run", "--diagnose"].includes(args[0])), "Use --run/--diagnose <new-output.json> or no arguments");
	const live = args.length === 2;
	const diagnostic = args[0] === "--diagnose";
	const callLimit = diagnostic ? 1 : MAX_CALLS;
	const prepared = { schemaVersion: 1, baseline: BASELINE, productionHead: git("rev-parse", "HEAD"),
		scriptSha256: hash(readFileSync(fileURLToPath(import.meta.url), "utf8")), compactionSha256: hash(source),
		provider: PROVIDER, model: MODEL, reasoning: "high", transport: "sse", cacheRetention: "none",
		maxCalls: callLimit, diagnostic, deadlineMs: DEADLINE_MS, outputCharLimit: OUTPUT_CHAR_LIMIT, retries: 0,
		requestedReserveTokens: 8192, serverTokenCapGuaranteed: false,
		promptSets, samples, observations: [] as Observation[], startedAt: new Date().toISOString(),
		finishedAt: undefined as string | undefined, outcome: "prepared", logicalCalls: 0, httpRequests: 0,
		limitations: ["Two synthetic cases; single run, no statistical inference", "Text summary only, not native compaction or session persistence",
			"Timing includes network/model variability; no production latency claim", "No server output token guarantee; deadline/stream guard are client-side",
			"Fact lists require semantic review; outputs are not CI goldens", "Usage is provider-reported; no billing/cost inference"],
	};
	// Reserve a new path before any credentials/network access; never overwrite an earlier run.
	const fd = live ? openSync(args[1], "wx") : undefined;
	function save(): void {
		if (fd !== undefined) writeFileSync(args[1], JSON.stringify(prepared, null, 2) + "\n");
	}
	try {
		save();
		const runtime = live ? await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false }) : undefined;
		const model = runtime?.getModel(PROVIDER, MODEL) ?? {
			id: MODEL, name: MODEL, provider: PROVIDER, api: "openai-codex-responses" as const, baseUrl: "",
			reasoning: true, input: ["text" as const], contextWindow: 272000, maxTokens: 128000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		if (runtime) {
			assert(runtime.getModel(PROVIDER, MODEL), "Configured evaluation model not available");
			assert(await runtime.checkAuth(PROVIDER), "Evaluation provider has no configured auth");
		}
		for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
			const sample = samples[sampleIndex];
			const previous: Record<Variant, string | undefined> = { legacy: undefined, current: undefined };
			for (let round = 0; round < sample.rounds.length; round++) {
				const order: Variant[] = (sampleIndex + round) % 2 === 0 ? ["legacy", "current"] : ["current", "legacy"];
				for (const variant of order) {
					const observation: Observation = { sample: sample.id, round: round + 1, variant,
						previousSummaryChars: previous[variant]?.length ?? 0, streamedChars: 0, httpRequests: 0, outcome: "pending" };
					prepared.observations.push(observation);
					const controller = new AbortController();
					const sessionId = "oc06-" + randomUUID();
					const timer = live ? setTimeout(() => controller.abort(), DEADLINE_MS) : undefined;
					const started = performance.now();
					const streamFn: StreamFn = async (requestModel, context, options) => {
						const actual = variantContext(context, variant, round);
						const serialized = JSON.stringify(actual, (key, value) => key === "timestamp" ? 0 : value);
						observation.requestSha256 = hash(serialized);
						observation.inputChars = serialized.length;
						observation.requestedMaxTokens = options?.maxTokens;
						if (!runtime) throw new Error("prepared");
						assert(++prepared.logicalCalls <= callLimit);
						const stream = runtime.streamSimple(requestModel, actual, { ...options, transport: "sse", maxRetries: 0,
							fetch: (input, init) => { observation.httpRequests++; prepared.httpRequests++;
								assert(observation.httpRequests <= 1 && prepared.httpRequests <= callLimit);
								return fetch(input, init); },
							onResponse: (response) => { observation.httpStatus = response.status; },
							onPayload: (payload) => {
								const body = payload as { max_output_tokens?: unknown; reasoning?: { effort?: unknown } };
								observation.serverOutputTokenCap = typeof body.max_output_tokens === "number" ? body.max_output_tokens : null;
								observation.wireReasoning = typeof body.reasoning?.effort === "string" ? body.reasoning.effort : undefined;
							},
						});
						// Drain delta events; only final text/usage is persisted.
						for await (const event of stream) {
							if (event.type === "text_delta" || event.type === "thinking_delta") {
								observation.streamedChars += event.delta.length;
								if (observation.streamedChars > OUTPUT_CHAR_LIMIT) controller.abort();
							}
						}
						const response = await stream.result();
						observation.stopReason = response.stopReason;
						observation.responseModel = response.model;
						if (response.stopReason !== "stop") {
							const error = response.errorMessage ?? "";
							observation.failureCategory = controller.signal.aborted ? "client-abort" :
								/usage limit|quota|rate.?limit|too many requests/i.test(error) ? "quota-or-rate-limit" :
								/not supported|unsupported|model.*not found|model.*not available/i.test(error) ? "model-or-option-unavailable" :
								/unauthorized|authentication|expired|invalid.*token/i.test(error) ? "authentication" :
								/fetch failed|network|socket|terminated|timed? ?out/i.test(error) ? "transport" : "other-provider-error";
						}
						assert(!controller.signal.aborted && response.stopReason === "stop", "Evaluation response not complete");
						return stream;
					};
					try {
						const result = await generateSummaryWithUsage(sample.rounds[round].messages, model, 8192,
							undefined, undefined, controller.signal, undefined, previous[variant], "high", streamFn,
							undefined, { enabled: false, maxRetries: 0, baseDelayMs: 0 }, undefined, sessionId);
						assert(result.text.trim().length > 0);
						previous[variant] = result.text;
						Object.assign(observation, { summary: result.text, summaryChars: result.text.length,
							usage: result.usage, outcome: "complete" });
					} catch (error) {
						if (!live && error instanceof Error && error.message === "prepared") {
							previous[variant] = "Synthetic previous summary for assembly validation.";
							observation.outcome = "prepared";
						}
						else { observation.outcome = "failed"; throw new Error("Evaluation stopped; no raw provider errors saved"); }
					} finally {
						clearTimeout(timer);
						cleanupSessionResources(sessionId);
						observation.elapsedMs = Math.round(performance.now() - started);
						save();
					}
					console.log((live ? "completed " : "prepared ") + sample.id + " round=" + (round + 1) + " " + variant + " chars=" + (observation.summaryChars ?? 0));
					if (diagnostic) { prepared.outcome = "diagnostic-complete"; return; }
				}
			}
		}
		prepared.outcome = live ? "complete" : "prepared";
		console.log(JSON.stringify({ outcome: prepared.outcome, cases: prepared.observations.length,
			logicalCalls: prepared.logicalCalls, httpRequests: prepared.httpRequests }));
	} catch {
		prepared.outcome = "failed";
		process.exitCode = 1;
		console.error("Evaluation failed; no automatic retry. Existing observations preserved.");
	} finally {
		prepared.finishedAt = new Date().toISOString();
		try { save(); } finally { if (fd !== undefined) closeSync(fd); }
	}
}
await main();
