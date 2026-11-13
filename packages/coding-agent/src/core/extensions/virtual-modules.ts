import * as _bundledPiAgentCore from "@super-pi/agent-core";
import * as _bundledPiAiCompat from "@super-pi/ai/compat";
import * as _bundledPiAiOauth from "@super-pi/ai/oauth";
import * as _bundledPiAiProviders from "@super-pi/ai/providers/all";
import * as _bundledPiTui from "@super-pi/tui";
import * as _bundledTypebox from "typebox";
import * as _bundledTypeboxCompile from "typebox/compile";
import * as _bundledTypeboxValue from "typebox/value";
// Loaded after loader.ts initializes, so the public entrypoint can re-export
// extension APIs without creating an eager module initialization cycle.
import * as _bundledPiCodingAgent from "../../index.ts";
import * as selectorLoader from "../../modes/interactive/components/selector-loader.ts";
import * as selectorText from "../../modes/interactive/components/selector-text.ts";
import * as taskForeground from "../tasks/foreground.ts";
import * as taskScheduler from "../tasks/scheduler.ts";
import * as taskRecords from "../tasks/tasks.ts";
import * as taskLimits from "../tasks/limits.ts";
import * as taskCheckpoints from "../tasks/checkpoints.ts";
import * as taskHistory from "../tasks/task-history.ts";
import * as taskPath from "../tasks/path.ts";
import * as taskShell from "../tasks/background-shell.ts";
import * as taskControls from "../tasks/managed-tasks.ts";
import * as fileCore from "../files/native-file-core.ts";
import * as fileCommit from "../files/file-commit.ts";
import * as fileCreation from "../files/file-creation.ts";
import * as filePathPolicy from "../files/protected-path-policy.ts";
import * as fileRegex from "../files/regex.ts";
import * as fileMetadata from "../files/file-commit-metadata.ts";
import * as fileClient from "../files/native-file-client.ts";
import * as filePath from "../files/file-path.ts";
import * as fileSnapshots from "../files/snapshot-line-edit.ts";
import * as fileSnapshotProtocol from "../files/snapshot-line-protocol.ts";
import * as fileSnapshotSyntax from "../files/snapshot-syntax-guard.ts";
import * as fileCompactSnapshot from "../files/compact-snapshot-capture.ts";
import * as filePreview from "../files/change-preview.ts";
import * as fileInvocation from "../files/file-invocation.ts";
import * as fileParameters from "../files/file-parameters.ts";
import * as fileBatchProtocol from "../files/file-batch-protocol.ts";
import * as fileResults from "../files/file-results.ts";
import * as fileChangeReceipts from "../files/change-receipts.ts";
import * as fileChanges from "../files/changes.ts";
import * as fileChangesV3 from "../files/file-changes-v3.ts";
import * as fileHost from "../files/file-host.ts";
import * as subagentExecution from "../files/subagent-execution.ts";
import * as sessionLease from "../session-lease.ts";
import * as shellCore from "../shell-policy/core.ts";
import * as shellPermissionBash from "../shell-policy/permission-bash.ts";
import * as shellPermissionPowerShell from "../shell-policy/permission-powershell.ts";
import * as shellAnalysis from "../shell-policy/shell-analysis.ts";
import * as shellRedirection from "../shell-policy/shell-redirection.ts";
import * as shellSubstitution from "../shell-policy/shell-substitution.ts";
import * as shellRegex from "../shell-policy/regex.ts";
import * as shellCodeMethodNames from "../shell-policy/code-method-names.ts";
import * as shellDiagnostics from "../shell-policy/policy-diagnostics.ts";
import * as shellReadonlyFind from "../shell-policy/readonly-find.ts";
import * as shellReadonlyFindLoop from "../shell-policy/readonly-find-loop.ts";
import * as shellReadonlyLoop from "../shell-policy/readonly-loop.ts";
import * as shellSortOptions from "../shell-policy/sort-options.ts";
import * as shellTimeout from "../shell-policy/timeout-wrapper.ts";

/** Modules available to extensions via virtualModules (for compiled Bun binary). */
export const VIRTUAL_MODULES: Record<string, unknown> = {
	typebox: _bundledTypebox,
	"typebox/compile": _bundledTypeboxCompile,
	"typebox/value": _bundledTypeboxValue,
	"@sinclair/typebox": _bundledTypebox,
	"@sinclair/typebox/compile": _bundledTypeboxCompile,
	"@sinclair/typebox/value": _bundledTypeboxValue,
	"@super-pi/agent-core": _bundledPiAgentCore,
	"@super-pi/tui": _bundledPiTui,
	"@super-pi/ai": _bundledPiAiCompat,
	"@super-pi/ai/compat": _bundledPiAiCompat,
	"@super-pi/ai/oauth": _bundledPiAiOauth,
	"@super-pi/ai/providers/all": _bundledPiAiProviders,
	"@super-pi/coding-agent": _bundledPiCodingAgent,
	"@super-pi/coding-agent/internal/ui/selector-loader": selectorLoader,
	"@super-pi/coding-agent/internal/ui/selector-text": selectorText,
	"@super-pi/coding-agent/internal/session-lease": sessionLease,
	"@super-pi/coding-agent/internal/shell-policy/core": shellCore,
	"@super-pi/coding-agent/internal/shell-policy/permission-bash": shellPermissionBash,
	"@super-pi/coding-agent/internal/shell-policy/permission-powershell": shellPermissionPowerShell,
	"@super-pi/coding-agent/internal/shell-policy/shell-analysis": shellAnalysis,
	"@super-pi/coding-agent/internal/shell-policy/shell-redirection": shellRedirection,
	"@super-pi/coding-agent/internal/shell-policy/shell-substitution": shellSubstitution,
	"@super-pi/coding-agent/internal/shell-policy/regex": shellRegex,
	"@super-pi/coding-agent/internal/shell-policy/code-method-names": shellCodeMethodNames,
	"@super-pi/coding-agent/internal/shell-policy/policy-diagnostics": shellDiagnostics,
	"@super-pi/coding-agent/internal/shell-policy/readonly-find": shellReadonlyFind,
	"@super-pi/coding-agent/internal/shell-policy/readonly-find-loop": shellReadonlyFindLoop,
	"@super-pi/coding-agent/internal/shell-policy/readonly-loop": shellReadonlyLoop,
	"@super-pi/coding-agent/internal/shell-policy/sort-options": shellSortOptions,
	"@super-pi/coding-agent/internal/shell-policy/timeout-wrapper": shellTimeout,
	"@super-pi/coding-agent/internal/files/native-file-core": fileCore,
	"@super-pi/coding-agent/internal/files/file-commit": fileCommit,
	"@super-pi/coding-agent/internal/files/file-creation": fileCreation,
	"@super-pi/coding-agent/internal/files/protected-path-policy": filePathPolicy,
	"@super-pi/coding-agent/internal/files/regex": fileRegex,
	"@super-pi/coding-agent/internal/files/file-commit-metadata": fileMetadata,
	"@super-pi/coding-agent/internal/files/native-file-client": fileClient,
	"@super-pi/coding-agent/internal/files/file-path": filePath,
	"@super-pi/coding-agent/internal/files/snapshot-line-edit": fileSnapshots,
	"@super-pi/coding-agent/internal/files/snapshot-line-protocol": fileSnapshotProtocol,
	"@super-pi/coding-agent/internal/files/snapshot-syntax-guard": fileSnapshotSyntax,
	"@super-pi/coding-agent/internal/files/compact-snapshot-capture": fileCompactSnapshot,
	"@super-pi/coding-agent/internal/files/change-preview": filePreview,
	"@super-pi/coding-agent/internal/files/file-invocation": fileInvocation,
	"@super-pi/coding-agent/internal/files/file-parameters": fileParameters,
	"@super-pi/coding-agent/internal/files/file-batch-protocol": fileBatchProtocol,
	"@super-pi/coding-agent/internal/files/file-results": fileResults,
	"@super-pi/coding-agent/internal/files/change-receipts": fileChangeReceipts,
	"@super-pi/coding-agent/internal/files/changes": fileChanges,
	"@super-pi/coding-agent/internal/files/file-changes-v3": fileChangesV3,
	"@super-pi/coding-agent/internal/files/file-host": fileHost,
	"@super-pi/coding-agent/internal/files/subagent-execution": subagentExecution,
	"@super-pi/coding-agent/internal/tasks/foreground": taskForeground,
	"@super-pi/coding-agent/internal/tasks/scheduler": taskScheduler,
	"@super-pi/coding-agent/internal/tasks/tasks": taskRecords,
	"@super-pi/coding-agent/internal/tasks/limits": taskLimits,
	"@super-pi/coding-agent/internal/tasks/checkpoints": taskCheckpoints,
	"@super-pi/coding-agent/internal/tasks/task-history": taskHistory,
	"@super-pi/coding-agent/internal/tasks/path": taskPath,
	"@super-pi/coding-agent/internal/tasks/background-shell": taskShell,
	"@super-pi/coding-agent/internal/tasks/managed-tasks": taskControls,
	"@mariozechner/pi-agent-core": _bundledPiAgentCore,
	"@mariozechner/pi-tui": _bundledPiTui,
	"@mariozechner/pi-ai": _bundledPiAiCompat,
	"@mariozechner/pi-ai/compat": _bundledPiAiCompat,
	"@mariozechner/pi-ai/oauth": _bundledPiAiOauth,
	"@mariozechner/pi-ai/providers/all": _bundledPiAiProviders,
	"@mariozechner/pi-coding-agent": _bundledPiCodingAgent,
};
