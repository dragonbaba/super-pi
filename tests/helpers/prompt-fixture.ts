import type { BuildSystemPromptOptions } from "../../packages/coding-agent/src/core/system-prompt.ts";
import { createSyntheticSourceInfo } from "../../packages/coding-agent/src/core/source-info.ts";

export function promptFixture(kind = "default"): BuildSystemPromptOptions {
	const options: BuildSystemPromptOptions = {
		cwd: "D:\\work\\项目",
		selectedTools: ["read", "bash"],
		toolSnippets: { read: "Read a file", bash: "Run a command" },
		promptGuidelines: [" extra ", "extra", ""],
		appendSystemPrompt: "Additional policy <&>\n",
		contextFiles: [{ path: "D:/项目/AGENTS.md", content: "workspace <&>\n" }],
		skills: [{ name: "a<&", description: "quote \" and ' 中文", filePath: "D:/skills/a&/SKILL.md", baseDir: "D:/skills/a&", sourceInfo: createSyntheticSourceInfo("fixture", { source: "fixture" }), disableModelInvocation: false }],
	};
	if (kind === "custom") options.customPrompt = "Custom\n<project_context>\n<available_skills>\n";
	if (kind === "empty") { options.customPrompt = ""; options.appendSystemPrompt = ""; options.selectedTools = []; }
	if (kind === "nested") { options.selectedTools = ["codemode"]; options.nestedTools = ["read", "bash"]; }
	return options;
}
