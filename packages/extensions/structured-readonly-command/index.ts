import { relative } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  type ExtensionAPI,
  truncateHead,
} from "@super-pi/coding-agent";
import { StringEnum } from "@super-pi/ai";
import { Text } from "@super-pi/tui";
import { Type } from "typebox";
import {
  classifyStructuredCommandResult,
  prepareStructuredCommand,
  type StructuredCommandCategory,
} from "./core.ts";
import { consumeStructuredReadonlyWorkspacePolicy } from "./delegation.ts";
import { executeBoundedCommand } from "./runner.ts";
import {
  classifyStructuredPreparationFailure,
  formatStructuredFailureContent,
  formatStructuredSuccessContent,
  structuredFailureSummary,
} from "./presentation.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_LINES = 400;

const StructuredReadonlyCommandParameters = Type.Object({
  cwd: Type.Optional(Type.String({
    description: "Working directory inside the current workspace; defaults to the workspace root",
    maxLength: 4096,
  })),
  command: StringEnum(["rg", "git"] as const, {
    description: "Allowlisted executable: rg, or git with a read-only subcommand",
  }),
  args: Type.Array(Type.String({ maxLength: 4096 }), {
    description: "Argument vector; shell syntax, scripts, and mutation-capable options are rejected",
    maxItems: 128,
  }),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 60_000 })),
  maxOutputLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })),
}, { additionalProperties: false });

interface StructuredCommandDetails {
  ok: boolean;
  category: StructuredCommandCategory;
  command: "git" | "rg";
  cwd: string;
  exitCode: number;
  killed: boolean;
  retryable: boolean;
  legalNextStep?: string;
  stateChanged: false;
  outputTruncated: boolean;
  outputLines: number;
  totalLines: number;
  retainedBytes: number;
  totalBytes: number;
}

function preparationErrorPayload(
  error: unknown,
  command: StructuredCommandDetails["command"],
  workspaceRoot: string,
  cwd: string,
): string {
  const output = error instanceof Error ? error.message : "Unknown command preparation error.";
  const classification = classifyStructuredPreparationFailure(output);
  const details: StructuredCommandDetails = {
    ok: false,
    category: classification.category,
    command,
    cwd: relative(workspaceRoot, cwd) || ".",
    exitCode: 1,
    killed: false,
    retryable: classification.retryable,
    ...(classification.legalNextStep ? { legalNextStep: classification.legalNextStep } : {}),
    stateChanged: false,
    outputTruncated: false,
    outputLines: output.length > 0 ? 1 : 0,
    totalLines: output.length > 0 ? 1 : 0,
    retainedBytes: Buffer.byteLength(output),
    totalBytes: Buffer.byteLength(output),
  };
  return formatStructuredFailureContent(details, output);
}

export default function structuredReadonlyCommandExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "structured_readonly_command",
    label: "Structured Read-only Command",
    description: "Run workspace-bounded read-only rg or Git with structured cwd/argv, exact Session grants, shell=false, and bounded output. Git allows status, diff, log, show, ls-files, and rev-parse.",
    promptSnippet: "Run bounded read-only rg or Git with structured argv",
    promptGuidelines: [
      "Prefer this over bash for supported rg/read-only Git. For rg use [options] -e PATTERN ROOT --glob GLOB; repeat -e and reserve -U for cross-line searches.",
    ],
    parameters: StructuredReadonlyCommandParameters,
    executionMode: "sequential",
    async execute(toolCallId, params, signal, _onUpdate, _ctx) {
      const workspacePolicy = consumeStructuredReadonlyWorkspacePolicy(params, toolCallId);
      let prepared;
      try {
        prepared = await prepareStructuredCommand(workspacePolicy.canonicalRoot, {
          ...params,
          cwd: workspacePolicy.canonicalCwd,
        }, workspacePolicy.authorizedRoots.slice(1));
      } catch (error) {
        throw new Error(preparationErrorPayload(
          error,
          params.command,
          workspacePolicy.canonicalRoot,
          workspacePolicy.canonicalCwd,
        ));
      }
      const result = await executeBoundedCommand(prepared.executable, prepared.args, {
        cwd: prepared.cwd,
        env: prepared.env,
        signal,
        timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      const category = classifyStructuredCommandResult(prepared.command, result.code, result.killed, result.output);
      const truncation = truncateHead(result.output, {
        maxBytes: DEFAULT_MAX_BYTES,
        maxLines: params.maxOutputLines ?? DEFAULT_MAX_OUTPUT_LINES,
      });
      const ok = category === "success" || category === "no_matches";
      const details: StructuredCommandDetails = {
        ok,
        category,
        command: prepared.command,
        cwd: relative(prepared.workspaceRoot, prepared.cwd) || ".",
        exitCode: result.code,
        killed: result.killed,
        retryable: category === "timeout_or_aborted" || category === "workdir_mismatch" || category === "input_validation",
        ...(category === "workdir_mismatch" ? {
          legalNextStep: "Set cwd to the target Git repository root and retry the same read-only Git subcommand.",
        } : category === "input_validation" ? {
          legalNextStep: "Correct the rg option, or pass a dash-prefixed search pattern through -e/--regexp and retry with an explicit existing root.",
        } : {}),
        stateChanged: false,
        outputTruncated: result.outputTruncated || truncation.truncated,
        outputLines: truncation.outputLines,
        totalLines: result.totalLines,
        retainedBytes: result.retainedBytes,
        totalBytes: result.totalBytes,
      };
      if (!ok) throw new Error(formatStructuredFailureContent(details, truncation.content));
      return {
        content: [{
          type: "text",
          text: formatStructuredSuccessContent(
            category,
            truncation.content,
            details.outputTruncated,
            details.outputLines,
            details.totalLines,
          ),
        }],
        details,
      };
    },
    renderCall(args, theme, _context) {
      let preview: string = args.command;
      for (const argument of args.args) preview += ` ${argument}`;
      if (preview.length > 180) preview = `${preview.slice(0, 179)}…`;
      return new Text(theme.fg("toolTitle", theme.bold(preview)), 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return new Text(theme.fg("warning", "Running…"), 0, 0);
      const contentPart = result.content[0];
      const content = contentPart?.type === "text" ? contentPart.text : "";
      const details = result.details as StructuredCommandDetails | undefined;
      if (context.isError || !details) {
        const failure = structuredFailureSummary(content);
        let text = theme.fg("error", failure.category ? `${failure.category}: ${failure.message}` : failure.message);
        if (failure.legalNextStep) text += `\n${theme.fg("muted", failure.legalNextStep)}`;
        return new Text(text, 0, 0);
      }
      if (details.category === "no_matches") return new Text(theme.fg("dim", "No matches"), 0, 0);
      if (!expanded) {
        const warning = details.outputTruncated
          ? theme.fg("warning", `Output truncated: ${details.outputLines}/${details.totalLines} lines`)
          : "";
        return new Text(warning, 0, 0);
      }
      let text = "";
      let offset = 0;
      let visible = 0;
      while (visible < 40 && offset < content.length) {
        const newline = content.indexOf("\n", offset);
        const end = newline < 0 ? content.length : newline;
        if (text) text += "\n";
        text += theme.fg("dim", content.slice(offset, end));
        visible += 1;
        if (newline < 0) {
          offset = content.length;
          break;
        }
        offset = newline + 1;
      }
      const hidden = Math.max(0, details.outputLines - visible);
      if (hidden > 0) text += `${text ? "\n" : ""}${theme.fg("muted", `… ${hidden} more lines hidden`)}`;
      return new Text(text, 0, 0);
    },
  });
}
