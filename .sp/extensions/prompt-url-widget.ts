import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { type ExtensionAPI, type ExtensionContext, type Theme } from "@super-pi/coding-agent";
import { type Component, Container, hyperlink, Text, type TUI } from "@super-pi/tui";

const PR_PROMPT_PATTERN = /^\s*You are given one or more GitHub PR URLs:\s*(\S+)/im;
const ISSUE_PROMPT_PATTERN = /^\s*Analyze GitHub issue\(s\):\s*(\S+)/im;
const ADVISORY_PROMPT_PATTERN = /^\s*Update a GitHub security advisory for publication:\s*(\S+)/im;
const ADVISORY_URL_PATTERN = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/security\/advisories\/(GHSA-[A-Za-z0-9-]+)(?:[/?#].*)?$/i;
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---/;
const ADVISORY_FIELD_PATTERN = /^advisory_url:\s*(.+)$/m;

type PromptMatch = {
	kind: "pr" | "issue" | "advisory";
	target: string;
};

type GhMetadata = {
	title?: string;
	detail?: string;
	displayUrl?: string;
	author?: {
		login?: string;
		name?: string | null;
	};
};

type GitHubAdvisoryMetadata = {
	ghsa_id?: string;
	summary?: string;
	severity?: string;
	state?: string;
	html_url?: string;
	cve_id?: string | null;
};

type AdvisoryRef = {
	owner: string;
	repo: string;
	ghsaId: string;
	url: string;
};

function extractPromptMatch(prompt: string): PromptMatch | undefined {
	const prMatch = prompt.match(PR_PROMPT_PATTERN);
	if (prMatch?.[1]) {
		return { kind: "pr", target: prMatch[1].trim() };
	}

	const issueMatch = prompt.match(ISSUE_PROMPT_PATTERN);
	if (issueMatch?.[1]) {
		return { kind: "issue", target: issueMatch[1].trim() };
	}

	const advisoryMatch = prompt.match(ADVISORY_PROMPT_PATTERN);
	if (advisoryMatch?.[1]) {
		return { kind: "advisory", target: advisoryMatch[1].trim() };
	}

	return undefined;
}

function getPromptLabel(kind: PromptMatch["kind"]): string {
	if (kind === "pr") return "PR";
	if (kind === "issue") return "Issue";
	return "Advisory";
}

function parseAdvisoryUrl(value: string): AdvisoryRef | undefined {
	const match = value.match(ADVISORY_URL_PATTERN);
	if (!match?.[1] || !match[2] || !match[3]) return undefined;
	return {
		owner: match[1],
		repo: match[2],
		ghsaId: match[3],
		url: `https://github.com/${match[1]}/${match[2]}/security/advisories/${match[3]}`,
	};
}

function unquoteYamlValue(value: string): string {
	const trimmed = value.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function resolveDraftPath(cwd: string, target: string): string {
	if (target === "~") return homedir();
	if (target.startsWith("~/")) return resolve(homedir(), target.slice(2));
	return resolve(cwd, target);
}

async function readAdvisoryRefFromDraft(cwd: string, target: string): Promise<AdvisoryRef | undefined> {
	try {
		const content = await readFile(resolveDraftPath(cwd, target), "utf8");
		const frontmatter = content.match(FRONTMATTER_PATTERN);
		const body = frontmatter?.[1] ?? content;
		const urlMatch = body.match(ADVISORY_FIELD_PATTERN);
		if (!urlMatch?.[1]) return undefined;
		return parseAdvisoryUrl(unquoteYamlValue(urlMatch[1]));
	} catch {
		return undefined;
	}
}

function formatAdvisoryDetail(advisory: GitHubAdvisoryMetadata): string | undefined {
	let text = "";
	for (const value of [advisory.ghsa_id, advisory.cve_id, advisory.severity, advisory.state]) {
		const part = value?.trim();
		if (part) text += (text ? " · " : "") + part;
	}
	return text || undefined;
}

async function fetchAdvisoryMetadata(pi: ExtensionAPI, cwd: string, target: string): Promise<GhMetadata | undefined> {
	const advisoryRef = parseAdvisoryUrl(target) ?? (await readAdvisoryRefFromDraft(cwd, target));
	if (!advisoryRef) return undefined;

	try {
		const result = await pi.exec("gh", [
			"api",
			`repos/${advisoryRef.owner}/${advisoryRef.repo}/security-advisories/${advisoryRef.ghsaId}`,
		]);
		if (result.code !== 0 || !result.stdout) return { displayUrl: advisoryRef.url };
		const advisory = JSON.parse(result.stdout) as GitHubAdvisoryMetadata;
		return {
			title: advisory.summary,
			detail: formatAdvisoryDetail(advisory),
			displayUrl: advisory.html_url ?? advisoryRef.url,
		};
	} catch {
		return { displayUrl: advisoryRef.url };
	}
}

async function fetchGhMetadata(
	pi: ExtensionAPI,
	kind: PromptMatch["kind"],
	target: string,
	cwd: string,
): Promise<GhMetadata | undefined> {
	if (kind === "advisory") {
		return fetchAdvisoryMetadata(pi, cwd, target);
	}

	const args =
		kind === "pr"
			? ["pr", "view", target, "--json", "title,author"]
			: ["issue", "view", target, "--json", "title,author"];

	try {
		const result = await pi.exec("gh", args);
		if (result.code !== 0 || !result.stdout) return undefined;
		return JSON.parse(result.stdout) as GhMetadata;
	} catch {
		return undefined;
	}
}

function formatAuthor(author?: GhMetadata["author"]): string | undefined {
	if (!author) return undefined;
	const name = author.name?.trim();
	const login = author.login?.trim();
	if (name && login) return `${name} (@${login})`;
	if (login) return `@${login}`;
	if (name) return name;
	return undefined;
}

function applySessionName(pi: ExtensionAPI, match: PromptMatch, metadata?: GhMetadata): void {
	const label = getPromptLabel(match.kind);
	const displayTarget = metadata?.displayUrl ?? match.target;
	const trimmedTitle = metadata?.title?.trim();
	const fallbackName = `${label}: ${match.target}`;
	const desiredFallbackName = `${label}: ${displayTarget}`;
	const desiredName = trimmedTitle ? `${label}: ${trimmedTitle} (${displayTarget})` : desiredFallbackName;
	const currentName = pi.getSessionName()?.trim();
	if (!currentName) {
		pi.setSessionName(desiredName);
		return;
	}
	if (currentName === match.target || currentName === fallbackName || currentName === desiredFallbackName) {
		pi.setSessionName(desiredName);
	}
}

function getUserText(content: string | { type: string; text?: string }[] | undefined): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	let text = "";
	let hasText = false;
	for (const block of content) {
		if (block.type !== "text") continue;
		text += (hasText ? "\n" : "") + (block.text ?? "");
		hasText = true;
	}
	return text;
}

class PromptUrlBorder implements Component {
	private readonly theme: Theme;
	constructor(theme: Theme) {
		this.theme = theme;
	}
	invalidate(): void {}
	render(width: number): string[] {
		return [this.theme.fg("muted", "─".repeat(Math.max(1, width)))];
	}
}

class PromptUrlWidgetOwner {
	private displayTarget = "";
	private title: string | undefined;
	private detail: string | undefined;
	private generation = 0;

	private readonly pi: ExtensionAPI;
	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	// The production UI invokes the factory synchronously in setExtensionWidget.
	// Only this owner keeps the factory; rendered components own their theme/text.
	readonly createWidget = (_tui: TUI, thm: Theme): Container => {
		const target = this.displayTarget;
		const title = this.title ? thm.fg("accent", this.title) : hyperlink(thm.fg("accent", target), target);
		let text = title;
		if (this.detail) text += `\n${thm.fg("muted", this.detail)}`;
		text += `\n${hyperlink(thm.fg("dim", target), target)}`;
		const container = new Container();
		container.addChild(new PromptUrlBorder(thm));
		container.addChild(new Text(text, 1, 0));
		return container;
	};

	private setWidget(ctx: ExtensionContext, match: PromptMatch, metadata?: GhMetadata): void {
		this.displayTarget = metadata?.displayUrl ?? match.target;
		this.title = metadata?.title;
		this.detail = metadata?.detail ?? formatAuthor(metadata?.author);
		ctx.ui.setWidget("prompt-url", this.createWidget);
	}

	private updatePromptContext(ctx: ExtensionContext, match: PromptMatch): void {
		const generation = ++this.generation;
		this.setWidget(ctx, match);
		applySessionName(this.pi, match);
		void this.resolveMetadata(ctx, match, generation);
	}

	private async resolveMetadata(ctx: ExtensionContext, match: PromptMatch, generation: number): Promise<void> {
		const metadata = await fetchGhMetadata(this.pi, match.kind, match.target, ctx.cwd);
		if (generation !== this.generation) return;
		this.setWidget(ctx, match, metadata);
		applySessionName(this.pi, match, metadata);
	}

	readonly beforeStart = (event: { prompt: string }, ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		const match = extractPromptMatch(event.prompt);
		if (match) this.updatePromptContext(ctx, match);
	};

	readonly clear = (): void => {
		this.generation++;
		this.displayTarget = "";
		this.title = undefined;
		this.detail = undefined;
	};

	readonly rebuild = (_event: unknown, ctx: ExtensionContext): void => {
		this.clear();
		if (!ctx.hasUI) return;
		const entries = ctx.sessionManager.getEntries();
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index]!;
			if (entry.type !== "message" || entry.message.role !== "user") continue;
			const match = extractPromptMatch(getUserText(entry.message.content));
			if (!match) continue;
			this.updatePromptContext(ctx, match);
			return;
		}
		ctx.ui.setWidget("prompt-url", undefined);
	};
}

export default function promptUrlWidgetExtension(pi: ExtensionAPI): void {
	const owner = new PromptUrlWidgetOwner(pi);
	pi.on("before_agent_start", owner.beforeStart);
	pi.on("session_start", owner.rebuild);
	pi.on("session_shutdown", owner.clear);
}
