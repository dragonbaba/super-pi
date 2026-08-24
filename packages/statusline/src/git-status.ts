import type { ExtensionAPI } from "@super-pi/coding-agent";
import { GIT_AHEAD_PATTERN, GIT_BEHIND_PATTERN, LINE_BREAK_PATTERN } from "./regex.js";
import { sanitizeTerminalText } from "./terminal-text.js";

const GIT_STATUS_TIMEOUT_MS = 3_000;
const COMPACT_NUMBER_FORMATTER = new Intl.NumberFormat("en", {
	notation: "compact",
	maximumFractionDigits: 1,
});

export interface GitStatusSummary {
	ahead: number;
	behind: number;
	staged: number;
	modified: number;
	untracked: number;
	conflicts: number;
}

export async function readGitStatus(
	pi: ExtensionAPI,
	cwd: string,
): Promise<GitStatusSummary | undefined> {
	const result = await pi.exec(
		"git",
		["--no-optional-locks", "status", "--porcelain=v1", "--branch", "--untracked-files=normal"],
		{ cwd, timeout: GIT_STATUS_TIMEOUT_MS },
	);
	if (result.code !== 0 || result.killed) return undefined;
	return parseGitStatusPorcelain(result.stdout);
}

export function parseGitStatusPorcelain(output: string): GitStatusSummary {
	const summary: GitStatusSummary = {
		ahead: 0,
		behind: 0,
		staged: 0,
		modified: 0,
		untracked: 0,
		conflicts: 0,
	};
	for (const line of output.split(LINE_BREAK_PATTERN)) {
		if (!line) continue;
		if (line.startsWith("## ")) {
			const ahead = line.match(GIT_AHEAD_PATTERN);
			const behind = line.match(GIT_BEHIND_PATTERN);
			summary.ahead = ahead ? Number(ahead[1]) : 0;
			summary.behind = behind ? Number(behind[1]) : 0;
			continue;
		}
		const indexStatus = line[0] ?? " ";
		const worktreeStatus = line[1] ?? " ";
		if (indexStatus === "?" && worktreeStatus === "?") {
			summary.untracked += 1;
			continue;
		}
		if (isConflictStatus(indexStatus, worktreeStatus)) {
			summary.conflicts += 1;
			continue;
		}
		if (isChangedStatus(indexStatus)) summary.staged += 1;
		if (isChangedStatus(worktreeStatus)) summary.modified += 1;
	}
	return summary;
}

function isConflictStatus(indexStatus: string, worktreeStatus: string): boolean {
	return (
		(indexStatus === "D" && worktreeStatus === "D") ||
		(indexStatus === "A" && worktreeStatus === "A") ||
		indexStatus === "U" ||
		worktreeStatus === "U"
	);
}

function isChangedStatus(status: string): boolean {
	return status !== " " && status !== "?" && status !== "!";
}

export function formatGitStatusSummary(summary: GitStatusSummary | undefined): string {
	if (!summary) return "";
	const tokens = [
		["⇡", summary.ahead],
		["⇣", summary.behind],
		["+", summary.staged],
		["~", summary.modified],
		["?", summary.untracked],
		["!", summary.conflicts],
	] as const;
	return tokens
		.filter(([, count]) => count > 0)
		.map(([prefix, count]) => `${prefix}${formatCount(count)}`)
		.join(" ");
}

export function formatGitBranchValue(
	branch: string | null,
	status: GitStatusSummary | undefined,
	pr?: string,
): string {
	if (!branch) return "no-git";
	const safeBranch = sanitizeTerminalText(branch, 120);
	const safePr = pr ? sanitizeTerminalText(pr, 80) : "";
	const suffixes = [formatGitStatusSummary(status), safePr ? `(${safePr})` : ""].filter(Boolean);
	return suffixes.length > 0 ? `${safeBranch} ${suffixes.join(" ")}` : safeBranch;
}

export function gitStatusSummaryEqual(
	left: GitStatusSummary | undefined,
	right: GitStatusSummary | undefined,
): boolean {
	if (!left || !right) return left === right;
	return (
		left.ahead === right.ahead &&
		left.behind === right.behind &&
		left.staged === right.staged &&
		left.modified === right.modified &&
		left.untracked === right.untracked &&
		left.conflicts === right.conflicts
	);
}

function formatCount(value: number): string {
	return COMPACT_NUMBER_FORMATTER.format(value);
}
