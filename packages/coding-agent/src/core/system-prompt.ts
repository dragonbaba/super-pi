/**
 * System prompt construction and project context loading
 */

import { getReadmePath } from "../config.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

function addUniqueGuideline(guidelines: string[], guideline: string): void {
	if (!guidelines.includes(guideline)) guidelines.push(guideline);
}

/** Direct model tools and Codemode children are both callable for guideline purposes. */
function hasCallableTool(tools: string[], nestedTools: string[] | undefined, name: string): boolean {
	return tools.includes(name) || nestedTools?.includes(name) === true;
}

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: string[];
	/** Callable through Codemode, not declared as direct model tools. */
	nestedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. */
	cwd: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

export interface SystemPromptSegment {
	readonly source: "default" | "custom" | "append" | "workspace" | "skills" | "cwd";
	readonly version: 1;
	readonly text: string;
}

/** Immutable, build-owned provenance; never an authorization credential. */
export interface SystemPromptComposition {
	readonly version: 1;
	readonly text: string;
	readonly segments: readonly SystemPromptSegment[];
	/** Migration bounds paired with these strings, independent of mutable resource options. */
	readonly dynamicSources: {
		readonly contextFileCount: number;
		readonly maxContextPathChars: number;
		readonly visibleSkillCount: number;
		readonly maxSkillPathChars: number;
	};
}

/** Compatibility entry point: providers and existing callers still receive a string. */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	return buildSystemPromptComposition(options).text;
}

/** Five aggregate segments, allocated only when the session rebuilds its prompt. */
export function buildSystemPromptComposition(options: BuildSystemPromptOptions): SystemPromptComposition {
	const {
		customPrompt,
		selectedTools,
		nestedTools,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const promptCwd = cwd.replace(/\\/g, "/");

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	let workspace = "", maxContextPathChars = 0;
	if (contextFiles.length > 0) {
		workspace = "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			workspace += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
			maxContextPathChars = Math.max(maxContextPathChars, filePath.length);
		}
		workspace += "</project_context>\n";
	}
	const hasRead = !selectedTools || hasCallableTool(selectedTools, nestedTools, "read");
	let visibleSkillCount = 0, maxSkillPathChars = 0;
	if (hasRead) {
		for (const skill of skills) {
			if (skill.disableModelInvocation) continue;
			visibleSkillCount++;
			maxSkillPathChars = Math.max(maxSkillPathChars, skill.filePath.length);
		}
	}
	const segments: readonly SystemPromptSegment[] = Object.freeze([
		Object.freeze({ source: customPrompt ? "custom" : "default", version: 1, text: customPrompt || buildDefaultPrompt(options) }),
		Object.freeze({ source: "append", version: 1, text: appendSection }),
		Object.freeze({ source: "workspace", version: 1, text: workspace }),
		Object.freeze({ source: "skills", version: 1, text: hasRead && skills.length > 0 ? formatSkillsForPrompt(skills) : "" }),
		Object.freeze({ source: "cwd", version: 1, text: `\nCurrent working directory: ${promptCwd}${customPrompt ? "\n" : ""}` }),
	]);
	let text = "";
	for (const segment of segments) text += segment.text;
	return Object.freeze({ version: 1, text, segments, dynamicSources: Object.freeze({ contextFileCount: contextFiles.length, maxContextPathChars, visibleSkillCount, maxSkillPathChars }) });
}

function buildDefaultPrompt({ selectedTools, nestedTools, toolSnippets, promptGuidelines }: BuildSystemPromptOptions): string {
	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();

	// Build tools list based on selected tools.
	// A tool appears in Available tools only when the caller provides a one-line snippet.
	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const toolsEnabled = tools.length > 0;
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];

	const hasBash = hasCallableTool(tools, nestedTools, "bash");
	const hasPowerShell = hasCallableTool(tools, nestedTools, "powershell");
	const hasGrep = hasCallableTool(tools, nestedTools, "grep");
	const hasFind = hasCallableTool(tools, nestedTools, "find");
	const hasLs = hasCallableTool(tools, nestedTools, "ls");

	// File exploration guidelines
	if ((hasBash || hasPowerShell) && !hasGrep && !hasFind && !hasLs) {
		if (hasBash && hasPowerShell) {
			addUniqueGuideline(guidelinesList, "Use bash or PowerShell for file operations like listing, searching, and finding files");
		} else if (hasPowerShell) {
			addUniqueGuideline(guidelinesList, "Use PowerShell for file operations like listing, searching, and finding files");
		} else {
			addUniqueGuideline(guidelinesList, "Use bash for file operations like ls, rg, find");
		}
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addUniqueGuideline(guidelinesList, normalized);
		}
	}

	// Always include these
	addUniqueGuideline(guidelinesList, "Be concise in your responses");
	addUniqueGuideline(guidelinesList, "Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	const introduction = toolsEnabled
		? "You are an expert coding assistant operating inside Super Pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files."
		: "You are an expert coding assistant operating inside Super Pi. Provide accurate guidance using the conversation and project context available to you.";
	const toolSection = toolsEnabled
		? `\n\nAvailable tools:\n${toolsList}\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.`
		: "";

	return `${introduction}${toolSection}

Guidelines:
${guidelines}

Super Pi package documentation (read only when the user asks about Super Pi itself):
- Package overview: ${readmePath}`;
}
