import {
	POLICY_FEEDBACK_PATH_PATTERN,
	POLICY_FEEDBACK_SECRET_PATTERN,
	POLICY_FEEDBACK_URL_PATTERN,
	POLICY_FEEDBACK_WHITESPACE_PATTERN,
} from "./policy-diagnostics-regex.ts";

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

const MAX_FEEDBACK_CHARS = 240;
const MAX_FRAGMENT_CHARS = 32;
const POLICY_DIAGNOSTIC_CODES: readonly PolicyDiagnosticCode[] = [
	"FD_DUP_UNSUPPORTED",
	"LAUNCHER_UNSUPPORTED",
	"DYNAMIC_EXECUTABLE",
	"DYNAMIC_TARGET",
	"INSPECTION_LIMIT",
	"PROTECTED_PATH",
	"USER_REJECTED",
	"AUTHORITY_EXPIRED",
	"UNKNOWN",
];
const POLICY_DIAGNOSTIC_ACTIONS = ["omit_syntax", "native_tool", "change_arguments", "ask_user", "stop"] as const;

/** Keep user feedback bounded and display-safe before it enters a tool result. */
export function sanitizePolicyFeedback(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const compact = value.replace(POLICY_FEEDBACK_WHITESPACE_PATTERN, " ").trim()
		.replace(POLICY_FEEDBACK_URL_PATTERN, "[URL redacted]")
		.replace(POLICY_FEEDBACK_SECRET_PATTERN, "[credential redacted]")
		.replace(POLICY_FEEDBACK_PATH_PATTERN, "[path redacted]")
		.trim();
	if (!compact) return undefined;
	const bounded = compact.length > MAX_FEEDBACK_CHARS
		? `${compact.slice(0, MAX_FEEDBACK_CHARS - 1)}…`
		: compact;
	for (let index = 0; index < bounded.length; index++) {
		const code = bounded.charCodeAt(index);
		if (code < 32 || code === 127) return undefined;
	}
	return bounded;
}

function boundedFragment(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_FRAGMENT_CHARS) return undefined;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code < 32 || code === 127 || value[index] === "\n" || value[index] === "\r") return undefined;
	}
	return value;
}

/** Read only producer-issued diagnostic facts; invalid legacy data is ignored. */
export function readPolicyDiagnostic(value: unknown): PolicyDiagnostic | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	if (typeof input.code !== "string" || !POLICY_DIAGNOSTIC_CODES.includes(input.code as PolicyDiagnosticCode)) return undefined;
	if (input.category !== "POLICY_BLOCKED" && input.category !== "SHELL_WRAPPER") return undefined;
	if (typeof input.retryable !== "boolean") return undefined;
	if (typeof input.action !== "string" || !(POLICY_DIAGNOSTIC_ACTIONS as readonly string[]).includes(input.action)) return undefined;
	const diagnostic: PolicyDiagnostic = {
		code: input.code as PolicyDiagnosticCode,
		category: input.category,
		retryable: input.retryable,
		action: input.action as PolicyDiagnostic["action"],
	};
	const syntax = boundedFragment(input.syntax);
	const launcher = boundedFragment(input.launcher);
	const nativeToolAvailable = typeof input.nativeToolAvailable === "boolean" ? input.nativeToolAvailable : undefined;
	return {
		...diagnostic,
		...(syntax ? { syntax } : {}),
		...(launcher ? { launcher } : {}),
		...(nativeToolAvailable === undefined ? {} : { nativeToolAvailable }),
	};
}

/** Render the same short model view for producers and legacy Agent projection. */
export function renderPolicyDiagnostic(diagnostic: PolicyDiagnostic): string {
	const prefix = `[${diagnostic.category}:${diagnostic.code}] Not executed:`;
	if (diagnostic.code === "FD_DUP_UNSUPPORTED") {
		return `${prefix}\nBash analysis does not support ${diagnostic.syntax ? `\`${diagnostic.syntax}\`` : "this descriptor-copy syntax"}.\nNext: omit stream merging only if stderr need not pass through the pipe; resubmit for authorization.`;
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
