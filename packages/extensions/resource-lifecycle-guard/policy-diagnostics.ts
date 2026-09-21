import { DISPLAY_WHITESPACE_PATTERN, FD_DUPLICATION_PATTERN } from "./regex.ts";

export type PolicyDiagnosticCode =
  | "FD_DUP_UNSUPPORTED"
  | "LAUNCHER_UNSUPPORTED"
  | "DYNAMIC_EXECUTABLE"
  | "DYNAMIC_TARGET"
  | "INSPECTION_LIMIT"
  | "PROTECTED_PATH"
  | "USER_REJECTED"
  | "AUTHORITY_EXPIRED"
  | "UNKNOWN";

export interface PolicyDiagnostic {
  readonly code: PolicyDiagnosticCode;
  readonly category: "POLICY_BLOCKED" | "SHELL_WRAPPER";
  readonly syntax?: string;
  readonly launcher?: string;
  readonly retryable: boolean;
  readonly action: "omit_syntax" | "native_tool" | "change_arguments" | "ask_user" | "stop";
  readonly nativeToolAvailable?: boolean;
}

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

export function renderPolicyDiagnostic(diagnostic: PolicyDiagnostic): string {
  const prefix = `[${diagnostic.category}:${diagnostic.code}] Not executed:`;
  if (diagnostic.code === "FD_DUP_UNSUPPORTED") {
    return `${prefix}\nBash analysis does not support \`${diagnostic.syntax ?? "2>&1"}\`.\nNext: omit stream merging only if stderr need not pass through the pipe; resubmit for authorization.`;
  }
  if (diagnostic.code === "LAUNCHER_UNSUPPORTED") {
    const launcher = diagnostic.launcher ? `the \`${diagnostic.launcher}\` launcher` : "this launcher";
    const next = diagnostic.nativeToolAvailable === true
      ? "Use the enabled native PowerShell tool for this query; normal authorization still applies."
      : "Use a directly inspectable foreground command; resubmit for authorization.";
    return `${prefix}\nBash analysis cannot inspect ${launcher}.\nNext: ${next}`;
  }
  if (diagnostic.code === "DYNAMIC_EXECUTABLE") {
    return `${prefix}\nThe executable position is dynamic and cannot be verified.\nNext: submit a literal executable for authorization.`;
  }
  if (diagnostic.code === "DYNAMIC_TARGET") {
    return `${prefix}\nThe target cannot be verified from this request.\nNext: submit a literal target for authorization.`;
  }
  if (diagnostic.code === "INSPECTION_LIMIT") {
    return `${prefix}\nThe Bash analysis limit was reached before the request could be verified.\nNext: submit a smaller, less nested request for authorization.`;
  }
  return `${prefix}\nBash analysis could not verify this request.\nNext: submit a simpler inspectable request for authorization.`;
}
