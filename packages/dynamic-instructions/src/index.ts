import { createHash } from "node:crypto";
import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext } from "@super-pi/coding-agent";

const MESSAGE_TYPE = "dynamic-instructions-v1";
const VERSION = 1;
const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
const MAX_CONTEXT_FILES = 64;
const MAX_SKILLS = 256;
const MAX_PATH_CHARS = 2_048;
const MAX_DYNAMIC_BYTES = 256 * 1024;
const DEFAULT_SELECTED_TOOLS = Object.freeze(["read", "bash", "edit", "write"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const XML_AMPERSAND_PATTERN = /&/gu;
const XML_LESS_THAN_PATTERN = /</gu;
const XML_GREATER_THAN_PATTERN = />/gu;
const XML_QUOTE_PATTERN = /"/gu;
const XML_APOSTROPHE_PATTERN = /'/gu;
const CONTEXT_HEADER = "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n";
const CONTEXT_FOOTER = "</project_context>\n";
const SKILL_HEADER = "\n\nThe following skills provide specialized instructions for specific tasks.\n"
  + "Use the read tool to load a skill's file when the task matches its description.\n"
  + "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.\n\n"
  + "<available_skills>";
const SKILL_FOOTER = "\n</available_skills>";
const SP_DOCS_HEADER = "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):";
const SP_DOCS_FOOTER = "- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)";
const SP_DOCS_COMPACT = "Pi-specific tasks: read Pi's installed README and relevant docs/examples before editing; follow referenced Markdown links.";

type HashState = {
  workspaceSha256?: string;
  skillsSha256?: string;
};

const NO_HASH_STATE: HashState = Object.freeze({});
const EMPTY_HASH_STATE: Required<HashState> = Object.freeze({
  workspaceSha256: EMPTY_SHA256,
  skillsSha256: EMPTY_SHA256,
});

type Projection = {
  options: BuildSystemPromptOptions;
  inputSystemPrompt: string;
  systemPrompt: string;
  workspace: string;
  skills: string;
  hashes: Required<HashState>;
  safe: boolean;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validHash(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function restoreHashes(ctx: ExtensionContext): HashState {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index] as unknown as {
      type?: unknown;
      customType?: unknown;
      details?: unknown;
    };
    if (entry.type !== "custom_message" || entry.customType !== MESSAGE_TYPE) continue;
    const details = entry.details as { version?: unknown; workspaceSha256?: unknown; skillsSha256?: unknown } | undefined;
    if (details?.version !== VERSION) continue;
    return {
      workspaceSha256: validHash(details.workspaceSha256) ? details.workspaceSha256 : undefined,
      skillsSha256: validHash(details.skillsSha256) ? details.skillsSha256 : undefined,
    };
  }
  return NO_HASH_STATE;
}

function formatContextFiles(options: BuildSystemPromptOptions): string | undefined {
  const files = options.contextFiles ?? [];
  if (files.length > MAX_CONTEXT_FILES) return undefined;
  if (files.length === 0) return "";
  let output = CONTEXT_HEADER;
  let bytes = Buffer.byteLength(CONTEXT_HEADER);
  for (const file of files) {
    if (file.path.length > MAX_PATH_CHARS) return undefined;
    const block = `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n\n`;
    bytes += Buffer.byteLength(block);
    if (bytes > MAX_DYNAMIC_BYTES) return undefined;
    output += block;
  }
  if (bytes + Buffer.byteLength(CONTEXT_FOOTER) > MAX_DYNAMIC_BYTES) return undefined;
  return output + CONTEXT_FOOTER;
}

function escapeXml(value: string): string {
  return value
    .replace(XML_AMPERSAND_PATTERN, "&amp;")
    .replace(XML_LESS_THAN_PATTERN, "&lt;")
    .replace(XML_GREATER_THAN_PATTERN, "&gt;")
    .replace(XML_QUOTE_PATTERN, "&quot;")
    .replace(XML_APOSTROPHE_PATTERN, "&apos;");
}

function formatSkills(options: BuildSystemPromptOptions): string | undefined {
  if (!(options.selectedTools ?? DEFAULT_SELECTED_TOOLS).includes("read")) return "";
  const skills = options.skills ?? [];
  let visibleCount = 0;
  let output = SKILL_HEADER;
  let bytes = Buffer.byteLength(SKILL_HEADER);
  for (const skill of skills) {
    if (skill.disableModelInvocation) continue;
    visibleCount += 1;
    if (visibleCount > MAX_SKILLS || skill.filePath.length > MAX_PATH_CHARS) return undefined;
    const block = "\n  <skill>"
      + `\n    <name>${escapeXml(skill.name)}</name>`
      + `\n    <description>${escapeXml(skill.description)}</description>`
      + `\n    <location>${escapeXml(skill.filePath)}</location>`
      + "\n  </skill>";
    bytes += Buffer.byteLength(block);
    if (bytes > MAX_DYNAMIC_BYTES) return undefined;
    output += block;
  }
  if (visibleCount === 0) return "";
  if (bytes + Buffer.byteLength(SKILL_FOOTER) > MAX_DYNAMIC_BYTES) return undefined;
  return output + SKILL_FOOTER;
}

function removeUniqueSection(systemPrompt: string, section: string): string | undefined {
  if (section.length === 0) return systemPrompt;
  const index = systemPrompt.indexOf(section);
  if (index < 0 || systemPrompt.indexOf(section, index + 1) >= 0) return undefined;
  return systemPrompt.slice(0, index) + systemPrompt.slice(index + section.length);
}

function compactPiDocs(systemPrompt: string): string {
  const start = systemPrompt.indexOf(SP_DOCS_HEADER);
  if (start < 0 || systemPrompt.indexOf(SP_DOCS_HEADER, start + 1) >= 0) return systemPrompt;
  const footer = systemPrompt.indexOf(SP_DOCS_FOOTER, start + SP_DOCS_HEADER.length);
  if (footer < 0 || systemPrompt.indexOf(SP_DOCS_FOOTER, footer + 1) >= 0) return systemPrompt;
  const end = footer + SP_DOCS_FOOTER.length;
  return systemPrompt.slice(0, start) + SP_DOCS_COMPACT + systemPrompt.slice(end);
}

function buildProjection(options: BuildSystemPromptOptions, systemPrompt: string): Projection {
  const workspace = formatContextFiles(options);
  const skills = formatSkills(options);
  if (workspace === undefined || skills === undefined
    || Buffer.byteLength(workspace) + Buffer.byteLength(skills) > MAX_DYNAMIC_BYTES) {
    return {
      options,
      inputSystemPrompt: systemPrompt,
      systemPrompt,
      workspace: "",
      skills: "",
      hashes: EMPTY_HASH_STATE,
      safe: false,
    };
  }
  const hashes = workspace.length === 0 && skills.length === 0
    ? EMPTY_HASH_STATE
    : { workspaceSha256: sha256(workspace), skillsSha256: sha256(skills) };

  const withoutSkills = removeUniqueSection(systemPrompt, skills);
  const withoutDynamic = withoutSkills === undefined ? undefined : removeUniqueSection(withoutSkills, workspace);
  const stablePrompt = withoutDynamic === undefined ? undefined : compactPiDocs(withoutDynamic);
  if (stablePrompt === undefined) {
    return {
      options,
      inputSystemPrompt: systemPrompt,
      systemPrompt,
      workspace,
      skills,
      hashes,
      safe: false,
    };
  }

  return {
    options,
    inputSystemPrompt: systemPrompt,
    systemPrompt: stablePrompt,
    workspace,
    skills,
    hashes,
    safe: true,
  };
}

function replacementContent(projection: Projection, workspaceChanged: boolean, skillsChanged: boolean): string {
  const parts = [
    "Dynamic instruction replacement (version 1). Newer replacements supersede older values for the named source.",
  ];
  if (workspaceChanged) {
    parts.push(
      projection.workspace.length > 0
        ? `Workspace/project instructions replacement:\n${projection.workspace}`
        : "Workspace/project instructions replacement: empty (previous workspace/project instructions no longer apply).",
    );
  }
  if (skillsChanged) {
    parts.push(
      projection.skills.length > 0
        ? `Available skill catalog replacement:\n${projection.skills}`
        : "Available skill catalog replacement: empty (previous skill catalog no longer applies).",
    );
  }
  return parts.join("\n\n");
}

export default function dynamicInstructions(pi: ExtensionAPI): void {
  let known: HashState | undefined;
  let cached: Projection | undefined;
  let stableResult: { systemPrompt: string } | undefined;

  pi.on("session_start", (_event, ctx) => {
    known = restoreHashes(ctx);
    cached = undefined;
    stableResult = undefined;
  });

  pi.on("before_agent_start", (event, ctx) => {
    // Durable session history is authoritative. Re-read it before deciding so
    // a failed custom-message append does not advance process-local state and
    // suppress the replacement on the next turn.
    known = restoreHashes(ctx);
    const options = event.systemPromptOptions;
    if (cached?.options !== options || cached.inputSystemPrompt !== event.systemPrompt) {
      cached = buildProjection(options, event.systemPrompt);
      stableResult = cached.safe && cached.systemPrompt !== event.systemPrompt
        ? { systemPrompt: cached.systemPrompt }
        : undefined;
    }
    if (!cached.safe) return undefined;
    if (known === cached.hashes) return stableResult;

    const workspaceChanged = known.workspaceSha256 !== cached.hashes.workspaceSha256
      && (cached.workspace.length > 0 || known.workspaceSha256 !== undefined);
    const skillsChanged = known.skillsSha256 !== cached.hashes.skillsSha256
      && (cached.skills.length > 0 || known.skillsSha256 !== undefined);

    if (!workspaceChanged && !skillsChanged) return stableResult;

    return {
      systemPrompt: cached.systemPrompt,
      message: {
        customType: MESSAGE_TYPE,
        content: replacementContent(cached, workspaceChanged, skillsChanged),
        display: false,
        details: {
          version: VERSION,
          workspaceSha256: cached.hashes.workspaceSha256,
          skillsSha256: cached.hashes.skillsSha256,
        },
      },
    };
  });
}
