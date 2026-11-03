# False-success guard

Runtime extension retaining structured `goal_complete` checks while verification evidence remains unresolved. Assistant replies are preserved without scanning completion wording or rewriting their content.

It adds no tool, slash command, or persistent prompt instruction.

## Policy

- Failed authoritative checks open an obligation by family and normalized target/package/workspace scope: test, typecheck, build, lint, or LSP diagnostics.
- A successful unrelated tool or same-family check in another directory does not resolve a failed check; the same verification family and scope must later succeed.
- Failed edit/write/fix calls require a successful same-target mutation or an authoritative verification whose target/package/workspace scope covers that target.
- A partial mutation (`stateChanged: true`) remains unresolved after a retry and until authoritative verification covers the same target.
- Exploratory search and missing optional paths do not open completion obligations.
- Successful tool results stay on a text-free fast path; only failed results collect up to 8 KiB for classification. This extension has no `message_end` handler and never reads final assistant drafts.
- `goal_complete` is blocked with a structured `unverified_completion` reason while obligations remain open.

## Lifecycle

Obligations are scoped to an explicit user boundary and carry normalized filesystem coverage. Interactive/RPC prompts and initial or resumed `pi-goal` prompts start a fresh lifecycle scope. They intentionally survive provider retries, compaction auto-continue messages, `pi-goal` automatic continuations, and interactive steer input. Session start and tree navigation clear branch-local state. Within a lifecycle scope, only matching target checks or package/workspace checks that contain the mutation target can discharge mutation evidence.

## Intervention audit

Each blocked `goal_complete` call appends a `false-success-intervention-v1` custom session entry. The versioned record is machine-readable and bounded: it stores only model identity, intervention kind/outcome, obligation count, and bounded tool/category metadata. It never stores assistant replies, tool output, mutation targets, or original tool arguments. Audit persistence is best-effort. Historical completion-replacement entries remain readable as session records; new replies do not generate them.
