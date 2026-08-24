/** Agent discovery and strictly validated configuration. */
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@super-pi/coding-agent";
import { canonicalizePath, isPathInside } from "./child-security.ts";
import { isSafeIdentifier, parseIdentifierList } from "./syntax.ts";

export type AgentScope = "user" | "project" | "both";
export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}
export interface AgentDiscoveryResult { agents: AgentConfig[]; projectAgentsDir: string | null }

const MAX_AGENT_FILE_BYTES = 128 * 1024;
const MAX_DESCRIPTION = 500;
const MAX_TOOLS = 32;
function validString(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0");
}

export function parseAgentDefinition(content: string, source: "user" | "project", filePath: string): AgentConfig | undefined {
	if (Buffer.byteLength(content, "utf8") > MAX_AGENT_FILE_BYTES) return undefined;
	let parsed: { frontmatter: Record<string, unknown>; body: string };
	try {
		parsed = parseFrontmatter<Record<string, unknown>>(content);
	} catch {
		return undefined;
	}
	const fm = parsed.frontmatter;
	if (!validString(fm.name, 64) || !isSafeIdentifier(fm.name)) return undefined;
	if (!validString(fm.description, MAX_DESCRIPTION)) return undefined;
	if (fm.tools !== undefined && typeof fm.tools !== "string") return undefined;
	if (Buffer.byteLength(parsed.body, "utf8") > MAX_AGENT_FILE_BYTES) return undefined;
	let tools: string[] | undefined;
	if (typeof fm.tools === "string") {
		const parsedTools = parseIdentifierList(fm.tools, MAX_TOOLS);
		if (!parsedTools.ok) return undefined;
		tools = parsedTools.values;
	}
	return {
		name: fm.name,
		description: fm.description,
		tools,
		systemPrompt: parsed.body,
		source,
		filePath,
	};
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	let root: string;
	try { root = canonicalizePath(dir, process.cwd(), true).path; } catch { return []; }
	let entries: fs.Dirent[];
	try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
	const agents: AgentConfig[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
		const rawPath = path.join(root, entry.name);
		try {
			const filePath = canonicalizePath(rawPath, root, true).path;
			if (!isPathInside(filePath, root) || !fs.statSync(filePath).isFile()) continue;
			const stat = fs.statSync(filePath);
			if (stat.size > MAX_AGENT_FILE_BYTES) continue;
			const agent = parseAgentDefinition(fs.readFileSync(filePath, "utf8"), source, filePath);
			if (agent) agents.push(agent);
		} catch { /* Ignore invalid/racing definitions. */ }
	}
	return agents;
}

export function findNearestProjectAgentsDir(cwd: string, trustedWorkspace: string): string | null {
	let currentDir: string;
	let boundary: string;
	try {
		currentDir = canonicalizePath(cwd, process.cwd(), true).path;
		boundary = canonicalizePath(trustedWorkspace, process.cwd(), true).path;
	} catch { return null; }
	if (!isPathInside(currentDir, boundary)) return null;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		try {
			const real = canonicalizePath(candidate, currentDir, true).path;
			if (isPathInside(real, boundary) && fs.statSync(real).isDirectory()) return real;
		} catch { /* Search the next parent within the trusted boundary. */ }
		if (currentDir === boundary) return null;
		const parentDir = path.dirname(currentDir);
		if (!isPathInside(parentDir, boundary)) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const bundledDir = process.env.SP_BUNDLED_AGENTS_DIR;
	const projectAgentsDir = findNearestProjectAgentsDir(cwd, cwd);
	const bundledAgents = scope === "project" || !bundledDir ? [] : loadAgentsFromDir(bundledDir, "user");
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");
	const agentMap = new Map<string, AgentConfig>();
	for (const agent of bundledAgents) agentMap.set(agent.name, agent);
	for (const agent of userAgents) agentMap.set(agent.name, agent);
	if (scope !== "user") for (const agent of projectAgents) agentMap.set(agent.name, agent);
	return { agents: [...agentMap.values()], projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (!agents.length) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	return { text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "), remaining: agents.length - listed.length };
}
