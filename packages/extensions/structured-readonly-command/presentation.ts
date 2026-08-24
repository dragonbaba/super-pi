import type { StructuredCommandCategory } from "./core.ts";

const MAX_SUMMARY_CHARS = 240;

export interface StructuredFailureSummary {
  category?: string;
  message: string;
  legalNextStep?: string;
}

export interface StructuredPreparationFailure {
  category: "workdir_mismatch" | "input_validation" | "command_failed";
  retryable: boolean;
  legalNextStep?: string;
}

export function classifyStructuredPreparationFailure(output: string): StructuredPreparationFailure {
  if (output.startsWith("WORKDIR_MISMATCH:")) {
    return {
      category: "workdir_mismatch",
      retryable: true,
      legalNextStep: "Set cwd to the target Git repository root.",
    };
  }
  if (output.startsWith("POLICY_BLOCKED:") || output.startsWith("INPUT_VALIDATION:")) {
    return {
      category: "input_validation",
      retryable: true,
      legalNextStep: "Correct the rejected argument and retry without changing command scope.",
    };
  }
  return { category: "command_failed", retryable: false };
}

export interface StructuredFailureContent {
  category: string;
  exitCode: number;
  legalNextStep?: string;
  outputTruncated: boolean;
  outputLines: number;
  totalLines: number;
}

function firstLine(value: string): string {
  const end = value.search(/[\r\n]/u);
  const line = (end < 0 ? value : value.slice(0, end)).trim();
  return line.length <= MAX_SUMMARY_CHARS ? line : `${line.slice(0, MAX_SUMMARY_CHARS - 1)}…`;
}

export function formatStructuredSuccessContent(
  category: StructuredCommandCategory,
  output: string,
  truncated: boolean,
  outputLines: number,
  totalLines: number,
): string {
  if (category === "no_matches") return "No matches.";
  if (!truncated) return output;
  return `${output}\n\n[Output truncated: showing ${outputLines} of ${totalLines} lines.]`;
}

export function formatStructuredFailureContent(details: StructuredFailureContent, output: string): string {
  let content = `[${details.category}] ${output || `Command exited with code ${details.exitCode}.`}`;
  if (details.outputTruncated) {
    content += `\n[Output truncated: showing ${details.outputLines} of ${details.totalLines} lines.]`;
  }
  if (details.legalNextStep) content += `\nRetry: ${details.legalNextStep}`;
  return content;
}

export function structuredFailureSummary(value: string): StructuredFailureSummary {
  const categoryEnd = value.startsWith("[") ? value.indexOf("]") : -1;
  const category = categoryEnd > 1 ? value.slice(1, categoryEnd) : undefined;
  const messageStart = category ? categoryEnd + 1 : 0;
  const retryMarker = "\nRetry: ";
  const retryStart = value.indexOf(retryMarker, messageStart);
  const messageEnd = retryStart < 0 ? value.length : retryStart;
  const message = firstLine(value.slice(messageStart, messageEnd));
  return {
    category,
    message: message || "Command failed.",
    legalNextStep: retryStart < 0 ? undefined : firstLine(value.slice(retryStart + retryMarker.length)),
  };
}
