import {
  DISPLAY_WHITESPACE_PATTERN,
  FD_DUPLICATION_PATTERN,
} from "./regex.ts";
import type { PolicyDiagnostic, PolicyDiagnosticCode } from "@super-pi/ai";

export { renderPolicyDiagnostic, sanitizePolicyFeedback } from "@super-pi/ai";
export type { PolicyDiagnostic, PolicyDiagnosticCode } from "@super-pi/ai";

export interface PolicyDiagnosticMetadata {
  readonly diagnostic: PolicyDiagnostic;
  readonly modelText: string;
}

const MAX_FRAGMENT_CHARS = 32;

function cleanFragment(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const compact = value.replace(DISPLAY_WHITESPACE_PATTERN, " ").trim();
  if (!compact || compact.length > MAX_FRAGMENT_CHARS) return undefined;
  for (let index = 0; index < compact.length; index++) {
    const code = compact.charCodeAt(index);
    if (code < 32 || code === 127) return undefined;
  }
  return compact;
}

export function diagnosticForPrimitives(
  primitives: readonly string[],
  options: { syntax?: string; launcher?: string } = {},
): PolicyDiagnostic {
  const syntax = cleanFragment(options.syntax);
  const launcher = cleanFragment(options.launcher);
  for (const primitive of primitives) {
    if (primitive === "unverifiable_redirection" && syntax && FD_DUPLICATION_PATTERN.test(syntax)) {
      return { code: "FD_DUP_UNSUPPORTED", category: "POLICY_BLOCKED", syntax: syntax ?? "2>&1", retryable: false, action: "omit_syntax" };
    }
    if (primitive === "unverifiable_launcher" || primitive === "opaque_shell_wrapper") {
      return { code: "LAUNCHER_UNSUPPORTED", category: "SHELL_WRAPPER", launcher, retryable: false, action: "native_tool" };
    }
    if (primitive === "dynamic_executable") return { code: "DYNAMIC_EXECUTABLE", category: "POLICY_BLOCKED", retryable: false, action: "change_arguments" };
    if (primitive === "dynamic_target" || primitive === "unverifiable_target" || primitive === "unverifiable_dynamic_scope") return { code: "DYNAMIC_TARGET", category: "POLICY_BLOCKED", retryable: false, action: "change_arguments" };
    if (primitive === "oversized_uninspectable" || primitive === "too_many_segments" || primitive === "too_many_targets") {
      return { code: "INSPECTION_LIMIT", category: "POLICY_BLOCKED", retryable: false, action: "change_arguments" };
    }
  }
  return { code: "UNKNOWN", category: "POLICY_BLOCKED", retryable: false, action: "stop" };
}

export function policyMetadata(
  diagnostic: PolicyDiagnostic,
  modelText: string,
): PolicyDiagnosticMetadata {
  return { diagnostic, modelText };
}
