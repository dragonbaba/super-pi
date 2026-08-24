import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { assessProtectedMutationPath } from "./protected-path-policy.ts";

export type MutationGuardCategory =
  | "READ_REQUIRED"
  | "STALE_STATE"
  | "MUTATION_BUDGET_EXCEEDED"
  | "EDIT_TARGET_AMBIGUOUS"
  | "NO_OP_EDIT"
  | "TARGET_APPEARED"
  | "WRITE_FAILED"
  | "EDIT_FAILED"
  | "PARTIAL_MUTATION"
  | "POLICY_BLOCKED";

export const MUTATION_RECEIPT_VERSION = 1;
export const MAX_EDIT_REPLACEMENTS = 20;
export const MAX_EDIT_SCOPE_BYTES = 256 * 1024;
export const MAX_TURN_MUTATION_CALLS = 24;
export const MAX_TURN_MUTATION_FILES = 16;
export const MAX_TURN_MUTATION_REPLACEMENTS = 100;
export const MAX_TURN_MUTATION_BYTES = 1024 * 1024;
const MAX_EDIT_OCCURRENCES = 256;
const MAX_EXPANDED_CONTEXT_BYTES = 16 * 1024;
const MAX_DISAMBIGUATION_BYTES = 2 * 1024 * 1024;
const MAX_EVIDENCE_PATHS = 32;
const MAX_EVIDENCE_PER_PATH = 16;
const MAX_MUTATION_SNAPSHOT_EVIDENCE_BYTES = MAX_EDIT_SCOPE_BYTES;

export interface ReadEvidence {
  sha256: string;
  toolCallId: string;
  turnGeneration: number;
}

export interface ReadRangeEvidence {
  text: string;
  startLine: number;
  endLine: number;
  toolCallId: string;
  turnGeneration: number;
}

export interface GuardedEdit {
  oldText: string;
  newText: string;
  expectedLine?: number;
}

export interface MutationGuardFailure {
  ok: false;
  category: MutationGuardCategory;
  operation: "write" | "edit";
  target: string;
  retryable: boolean;
  stateChanged: boolean;
  expectedSha256?: string;
  actualSha256?: string;
  cause?: string;
  protectedRoots?: string[];
  policyReason?: "protected_root" | "confirmation_required" | "user_rejected";
  requiresConfirmation?: boolean;
}

export interface MutationPathApproval {
  canonicalTarget: string;
  protectedRoots: readonly string[];
}

export interface MutationEditAuthorization {
  target: string;
  replacements: number;
  omittedNoOpEdits: number;
  estimatedChangedBytes: number;
  edits: Array<{ oldText: string; newText: string }>;
  reservationId: number;
}

interface MutationBudgetEntry {
  target: string;
  replacements: number;
  bytes: number;
}

export interface MutationWriteGuardOptions {
  /** Deterministic test hook at the last path-verification/create boundary. */
  beforeExclusiveCreate?: (absolutePath: string) => void | Promise<void>;
}

export interface MutationWriteSuccess {
  ok: true;
  mutationReceiptVersion: 1;
  category: "success";
  operation: "write";
  target: string;
  stateChanged: true;
  created?: true;
  previousSha256?: string;
  sha256: string;
}

export function normalizeToolPath(path: string): string {
  return path.startsWith("@") ? path.slice(1) : path;
}

export function resolveToolPath(cwd: string, path: string): string {
  const normalized = normalizeToolPath(path);
  return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

export function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function canonicalExistingPath(path: string): Promise<string> {
  return realpath(resolve(path));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function hashFile(path: string): Promise<string> {
  return sha256(await readFile(path));
}

async function missingParentDirectories(path: string): Promise<string[]> {
  const missing: string[] = [];
  let current = dirname(path);
  while (!(await pathExists(current))) {
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return missing;
}

async function rollbackEmptyDirectories(paths: readonly string[]): Promise<boolean> {
  for (const path of paths) {
    try {
      await rmdir(path);
    } catch {
      // Never recursively remove: a concurrent writer may now own content here.
    }
  }
  for (const path of paths) {
    if (await pathExists(path)) return false;
  }
  return true;
}

function displayPath(cwd: string, absolutePath: string): string {
  const relativePath = relative(cwd, absolutePath);
  if (relativePath === "") return ".";
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    return absolutePath;
  }
  return relativePath;
}

function normalizeEvidenceText(text: string): string {
  if (!text.includes("\r")) return text;
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function editScopeBytes(edits: readonly { oldText: string; newText: string }[]): number {
  let total = 0;
  for (const edit of edits) {
    total += Buffer.byteLength(edit.oldText, "utf8") + Buffer.byteLength(edit.newText, "utf8");
  }
  return total;
}

function occurrenceOffsets(content: string, value: string): number[] {
  if (!value) return [];
  const offsets: number[] = [];
  let from = 0;
  while (from <= content.length - value.length && offsets.length <= MAX_EDIT_OCCURRENCES) {
    const offset = content.indexOf(value, from);
    if (offset < 0) break;
    offsets.push(offset);
    from = offset + Math.max(1, value.length);
  }
  return offsets;
}

function buildLineStarts(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function lineAtOffset(lineStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (lineStarts[middle] <= offset) low = middle + 1;
    else high = middle;
  }
  return Math.max(1, low);
}

function previousLineStart(content: string, start: number): number {
  if (start <= 0) return 0;
  const newline = content.lastIndexOf("\n", Math.max(0, start - 2));
  return newline < 0 ? 0 : newline + 1;
}

function nextLineEnd(content: string, end: number): number {
  if (end >= content.length) return content.length;
  const newline = content.indexOf("\n", end);
  return newline < 0 ? content.length : newline + 1;
}

function uniquelyExpandEdit(
  content: string,
  edit: GuardedEdit,
  targetOffset: number,
): { oldText: string; newText: string } | undefined {
  let start = content.lastIndexOf("\n", Math.max(0, targetOffset - 1)) + 1;
  let end = nextLineEnd(content, targetOffset + edit.oldText.length);
  while (true) {
    const candidate = content.slice(start, end);
    if (Buffer.byteLength(candidate, "utf8") > MAX_EXPANDED_CONTEXT_BYTES) return undefined;
    const occurrences = occurrenceOffsets(content, candidate);
    if (occurrences.length === 1 && occurrences[0] === start) {
      const prefix = content.slice(start, targetOffset);
      const suffix = content.slice(targetOffset + edit.oldText.length, end);
      return { oldText: candidate, newText: `${prefix}${edit.newText}${suffix}` };
    }
    const expandedStart = previousLineStart(content, start);
    const expandedEnd = nextLineEnd(content, end);
    if (expandedStart === start && expandedEnd === end) return undefined;
    start = expandedStart;
    end = expandedEnd;
  }
}

function guardFailure(failure: MutationGuardFailure): Error {
  return new Error(JSON.stringify(failure, null, 2));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mutationStateChanged(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  try {
    const payload = JSON.parse(error.message) as { stateChanged?: unknown };
    return payload.stateChanged === true;
  } catch {
    return false;
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export class MutationWriteGuard {
  readonly #evidence = new Map<string, ReadEvidence>();
  readonly #rangeEvidence = new Map<string, ReadRangeEvidence[]>();
  readonly #budgetEntries = new Map<number, MutationBudgetEntry>();
  readonly #budgetFileReferences = new Map<string, number>();
  #budgetGeneration = -1;
  #budgetReplacements = 0;
  #budgetBytes = 0;
  #nextReservationId = 1;
  readonly #options: MutationWriteGuardOptions;

  constructor(options: MutationWriteGuardOptions = {}) {
    this.#options = options;
  }

  clear(): void {
    this.#evidence.clear();
    this.#rangeEvidence.clear();
    this.#resetTurnBudget(-1);
  }

  releaseMutation(reservationId: number | undefined): void {
    if (reservationId === undefined) return;
    const entry = this.#budgetEntries.get(reservationId);
    if (!entry) return;
    this.#budgetEntries.delete(reservationId);
    this.#budgetReplacements -= entry.replacements;
    this.#budgetBytes -= entry.bytes;
    const references = this.#budgetFileReferences.get(entry.target) ?? 0;
    if (references <= 1) this.#budgetFileReferences.delete(entry.target);
    else this.#budgetFileReferences.set(entry.target, references - 1);
  }

  async #assertMutationPathAllowed(
    cwd: string,
    path: string,
    operation: "write" | "edit",
    approval?: MutationPathApproval,
  ): Promise<string> {
    const absolutePath = resolveToolPath(cwd, path);
    const assessment = await assessProtectedMutationPath(cwd, absolutePath);
    if (assessment.violations.length === 0 && assessment.canonicalTarget) return assessment.canonicalTarget;
    if (approval && assessment.canonicalTarget === approval.canonicalTarget
      && sameStrings(assessment.violations, approval.protectedRoots)) return assessment.canonicalTarget;
    const unverifiable = assessment.canonicalTarget === undefined;
    throw guardFailure({
      ok: false,
      category: "POLICY_BLOCKED",
      operation,
      target: displayPath(cwd, absolutePath),
      retryable: !unverifiable,
      stateChanged: false,
      protectedRoots: assessment.violations,
      policyReason: unverifiable ? "protected_root" : "confirmation_required",
      requiresConfirmation: !unverifiable,
      cause: unverifiable
        ? "Mutation target cannot be canonicalized safely."
        : "Mutation target requires explicit per-call confirmation.",
    });
  }

  #resetTurnBudget(turnGeneration: number): void {
    this.#budgetGeneration = turnGeneration;
    this.#budgetEntries.clear();
    this.#budgetFileReferences.clear();
    this.#budgetReplacements = 0;
    this.#budgetBytes = 0;
  }

  #reserveMutation(
    turnGeneration: number,
    target: string,
    operation: "write" | "edit",
    replacements: number,
    bytes: number,
  ): number {
    if (this.#budgetGeneration !== turnGeneration) this.#resetTurnBudget(turnGeneration);
    const createsFileReference = !this.#budgetFileReferences.has(target);
    const projectedCalls = this.#budgetEntries.size + 1;
    const projectedFiles = this.#budgetFileReferences.size + (createsFileReference ? 1 : 0);
    const projectedReplacements = this.#budgetReplacements + replacements;
    const projectedBytes = this.#budgetBytes + bytes;
    if (projectedCalls > MAX_TURN_MUTATION_CALLS
      || projectedFiles > MAX_TURN_MUTATION_FILES
      || projectedReplacements > MAX_TURN_MUTATION_REPLACEMENTS
      || projectedBytes > MAX_TURN_MUTATION_BYTES) {
      throw guardFailure({
        ok: false,
        category: "MUTATION_BUDGET_EXCEEDED",
        operation,
        target,
        retryable: true,
        stateChanged: false,
        cause: `Per-turn mutation budget would reach ${projectedCalls} call(s), ${projectedFiles} file(s), ${projectedReplacements} replacement(s), and ${projectedBytes} byte(s); allowed ${MAX_TURN_MUTATION_CALLS}, ${MAX_TURN_MUTATION_FILES}, ${MAX_TURN_MUTATION_REPLACEMENTS}, and ${MAX_TURN_MUTATION_BYTES}.`,
      });
    }
    const reservationId = this.#nextReservationId++;
    this.#budgetEntries.set(reservationId, { target, replacements, bytes });
    this.#budgetFileReferences.set(target, (this.#budgetFileReferences.get(target) ?? 0) + 1);
    this.#budgetReplacements = projectedReplacements;
    this.#budgetBytes = projectedBytes;
    return reservationId;
  }

  #setCompleteEvidence(canonicalPath: string, evidence: ReadEvidence): void {
    if (!this.#evidence.has(canonicalPath) && this.#evidence.size >= MAX_EVIDENCE_PATHS) {
      const oldestPath = this.#evidence.keys().next().value;
      if (oldestPath !== undefined) {
        this.#evidence.delete(oldestPath);
        this.#rangeEvidence.delete(oldestPath);
      }
    }
    this.#evidence.delete(canonicalPath);
    this.#evidence.set(canonicalPath, evidence);
  }

  async recordRead(
    cwd: string,
    path: string,
    text: string,
    startLine: number,
    endLine: number,
    toolCallId: string,
    turnGeneration: number,
    complete: boolean,
  ): Promise<void> {
    const canonicalPath = await canonicalExistingPath(resolveToolPath(cwd, path));
    const evidence = this.#rangeEvidence.get(canonicalPath) ?? [];
    if (!this.#rangeEvidence.has(canonicalPath) && this.#rangeEvidence.size >= MAX_EVIDENCE_PATHS) {
      const oldestPath = this.#rangeEvidence.keys().next().value;
      if (oldestPath !== undefined) {
        this.#rangeEvidence.delete(oldestPath);
        this.#evidence.delete(oldestPath);
      }
    }
    if (evidence.length >= MAX_EVIDENCE_PER_PATH) evidence.shift();
    evidence.push({
      text: normalizeEvidenceText(text),
      startLine,
      endLine,
      toolCallId,
      turnGeneration,
    });
    this.#rangeEvidence.delete(canonicalPath);
    this.#rangeEvidence.set(canonicalPath, evidence);
    let completeEvidence = complete;
    if (!completeEvidence && startLine === 1) {
      const textBytes = Buffer.byteLength(text, "utf8");
      const fileInfo = await lstat(canonicalPath);
      if (fileInfo.isFile() && fileInfo.size === textBytes) {
        completeEvidence = sha256(await readFile(canonicalPath)) === sha256(text);
      }
    }
    if (completeEvidence) {
      this.#setCompleteEvidence(canonicalPath, { sha256: sha256(text), toolCallId, turnGeneration });
    }
  }

  async recordCompleteRead(
    cwd: string,
    path: string,
    text: string,
    toolCallId: string,
    turnGeneration: number,
  ): Promise<void> {
    await this.recordRead(
      cwd,
      path,
      text,
      1,
      Number.MAX_SAFE_INTEGER,
      toolCallId,
      turnGeneration,
      true,
    );
  }

  async recordMutationSnapshot(
    cwd: string,
    path: string,
    expectedSha256: string,
    toolCallId: string,
    turnGeneration: number,
  ): Promise<void> {
    const canonicalPath = await canonicalExistingPath(resolveToolPath(cwd, path));
    const diskContent = await readFile(canonicalPath);
    const diskSha256 = sha256(diskContent);
    if (diskSha256 !== expectedSha256) {
      this.#evidence.delete(canonicalPath);
      this.#rangeEvidence.delete(canonicalPath);
      throw new Error("Mutation disk readback does not match the successful tool result hash.");
    }
    this.#setCompleteEvidence(canonicalPath, {
      sha256: diskSha256,
      toolCallId,
      turnGeneration,
    });
    this.#rangeEvidence.delete(canonicalPath);
    if (diskContent.byteLength <= MAX_MUTATION_SNAPSHOT_EVIDENCE_BYTES) {
      const decoded = diskContent.toString("utf8");
      this.#rangeEvidence.set(canonicalPath, [{
        text: normalizeEvidenceText(decoded.startsWith("\uFEFF") ? decoded.slice(1) : decoded),
        startLine: 1,
        endLine: Number.MAX_SAFE_INTEGER,
        toolCallId,
        turnGeneration,
      }]);
    }
  }

  async invalidate(cwd: string, path: string): Promise<void> {
    const absolutePath = resolveToolPath(cwd, path);
    this.#evidence.delete(absolutePath);
    this.#rangeEvidence.delete(absolutePath);
    try {
      const canonicalPath = await canonicalExistingPath(absolutePath);
      this.#evidence.delete(canonicalPath);
      this.#rangeEvidence.delete(canonicalPath);
    } catch {
      // A missing path cannot retain useful existing-file evidence.
    }
  }

  async assertEditPathAllowed(
    cwd: string,
    path: string,
    pathApproval?: MutationPathApproval,
  ): Promise<string> {
    return this.#assertMutationPathAllowed(cwd, path, "edit", pathApproval);
  }

  reserveSnapshotEdit(
    turnGeneration: number,
    canonicalPath: string,
    replacements: number,
    bytes: number,
  ): number {
    const target = canonicalPath;
    if (replacements < 1 || replacements > MAX_EDIT_REPLACEMENTS || bytes < 0 || bytes > MAX_EDIT_SCOPE_BYTES) {
      throw guardFailure({
        ok: false,
        category: "MUTATION_BUDGET_EXCEEDED",
        operation: "edit",
        target,
        retryable: true,
        stateChanged: false,
        cause: `Requested ${replacements} snapshot operation(s) and ${bytes} scoped byte(s); allowed ${MAX_EDIT_REPLACEMENTS} and ${MAX_EDIT_SCOPE_BYTES}.`,
      });
    }
    return this.#reserveMutation(turnGeneration, canonicalPath, "edit", replacements, bytes);
  }

  async authorizeEdit(
    cwd: string,
    path: string,
    edits: readonly GuardedEdit[],
    turnGeneration: number,
    currentText?: string,
    pathApproval?: MutationPathApproval,
  ): Promise<MutationEditAuthorization> {
    const absolutePath = resolveToolPath(cwd, path);
    const target = displayPath(cwd, absolutePath);
    await this.#assertMutationPathAllowed(cwd, path, "edit", pathApproval);
    const effectiveEdits: GuardedEdit[] = [];
    const originalIndexes: number[] = [];
    for (let index = 0; index < edits.length; index++) {
      const edit = edits[index];
      if (normalizeEvidenceText(edit?.oldText ?? "") === normalizeEvidenceText(edit?.newText ?? "")) continue;
      effectiveEdits.push(edit);
      originalIndexes.push(index);
    }
    if (effectiveEdits.length === 0) {
      throw guardFailure({
        ok: false,
        category: "NO_OP_EDIT",
        operation: "edit",
        target,
        retryable: true,
        stateChanged: false,
        cause: `All ${edits.length} edit replacement(s) are identical after line-ending normalization; provide at least one state-changing replacement.`,
      });
    }
    this.#assertEditBudget(target, effectiveEdits);

    const canonicalPath = await canonicalExistingPath(absolutePath);
    const evidence = this.#rangeEvidence.get(canonicalPath) ?? [];
    const content = currentText === undefined
      ? undefined
      : normalizeEvidenceText(currentText.startsWith("\uFEFF") ? currentText.slice(1) : currentText);
    const prepared: Array<{ oldText: string; newText: string }> = [];
    const missing: number[] = [];
    let lineStarts: number[] | undefined;
    let contentBytes: number | undefined;
    let hasPriorFileEvidence = false;
    for (const item of evidence) {
      if (item.turnGeneration < turnGeneration) {
        hasPriorFileEvidence = true;
        break;
      }
    }

    for (let effectiveIndex = 0; effectiveIndex < effectiveEdits.length; effectiveIndex++) {
      const edit = effectiveEdits[effectiveIndex];
      const index = originalIndexes[effectiveIndex];
      const oldText = normalizeEvidenceText(edit?.oldText ?? "");
      if (edit.expectedLine !== undefined && (!Number.isInteger(edit.expectedLine) || edit.expectedLine < 1)) {
        throw guardFailure({
          ok: false,
          category: "EDIT_TARGET_AMBIGUOUS",
          operation: "edit",
          target,
          retryable: true,
          stateChanged: false,
          cause: `edits[${index}].expectedLine must be a positive 1-indexed integer.`,
        });
      }
      let hasMatchingEvidence = false;
      let hasExpectedLineEvidence = edit.expectedLine === undefined;
      for (let evidenceIndex = evidence.length - 1; evidenceIndex >= 0; evidenceIndex--) {
        const item = evidence[evidenceIndex];
        if (item.turnGeneration >= turnGeneration || !item.text.includes(oldText)) continue;
        hasMatchingEvidence = true;
        if (edit.expectedLine !== undefined
          && edit.expectedLine >= item.startLine
          && edit.expectedLine <= item.endLine) hasExpectedLineEvidence = true;
      }
      if (!oldText) {
        missing.push(index);
        continue;
      }
      if (content === undefined) {
        if (!hasMatchingEvidence || !hasExpectedLineEvidence) missing.push(index);
        else prepared.push({ oldText: edit.oldText, newText: edit.newText });
        continue;
      }

      const offsets = occurrenceOffsets(content, oldText);
      if (offsets.length > MAX_EDIT_OCCURRENCES) {
        throw guardFailure({
          ok: false,
          category: "EDIT_TARGET_AMBIGUOUS",
          operation: "edit",
          target,
          retryable: true,
          stateChanged: false,
          cause: `edits[${index}] exceeded the bounded occurrence limit; provide a larger unique oldText.`,
        });
      }
      if (offsets.length <= 1) {
        if (!hasMatchingEvidence && !hasPriorFileEvidence) {
          missing.push(index);
          continue;
        }
        if (offsets.length === 0 && edit.expectedLine !== undefined) {
          throw guardFailure({
            ok: false,
            category: "EDIT_TARGET_AMBIGUOUS",
            operation: "edit",
            target,
            retryable: true,
            stateChanged: false,
            cause: `edits[${index}].expectedLine requires an exact oldText occurrence in the queued snapshot.`,
          });
        }
        // expectedLine is only a repeated-target disambiguator. Exact content
        // identity is authoritative when oldText occurs once, even if prior
        // edits shifted its line number after the model observed it.
        prepared.push({ oldText: edit.oldText, newText: edit.newText });
        continue;
      }

      if (!hasMatchingEvidence) {
        missing.push(index);
        continue;
      }
      if (!hasExpectedLineEvidence) {
        missing.push(index);
        continue;
      }
      contentBytes ??= Buffer.byteLength(content, "utf8");
      if (contentBytes > MAX_DISAMBIGUATION_BYTES) {
        throw guardFailure({
          ok: false,
          category: "EDIT_TARGET_AMBIGUOUS",
          operation: "edit",
          target,
          retryable: true,
          stateChanged: false,
          cause: `edits[${index}] is repeated in a snapshot larger than the bounded disambiguation limit; provide a larger unique oldText.`,
        });
      }
      lineStarts ??= buildLineStarts(content);
      let expectedLine = edit.expectedLine;
      if (expectedLine === undefined) {
        for (let evidenceIndex = evidence.length - 1; evidenceIndex >= 0; evidenceIndex--) {
          const receipt = evidence[evidenceIndex];
          if (receipt.turnGeneration >= turnGeneration || !receipt.text.includes(oldText)) continue;
          let coveredCount = 0;
          let coveredLine = 0;
          for (const offset of offsets) {
            const line = lineAtOffset(lineStarts, offset);
            if (line < receipt.startLine || line > receipt.endLine) continue;
            coveredCount += 1;
            coveredLine = line;
            if (coveredCount > 1) break;
          }
          if (coveredCount === 1) {
            expectedLine = coveredLine;
            break;
          }
        }
      }
      let selectedCount = 0;
      let selectedOffset = -1;
      if (expectedLine !== undefined) {
        for (const offset of offsets) {
          if (lineAtOffset(lineStarts, offset) !== expectedLine) continue;
          selectedCount += 1;
          selectedOffset = offset;
          if (selectedCount > 1) break;
        }
      }
      if (selectedCount !== 1) {
        throw guardFailure({
          ok: false,
          category: "EDIT_TARGET_AMBIGUOUS",
          operation: "edit",
          target,
          retryable: true,
          stateChanged: false,
          cause: `edits[${index}] has ${offsets.length} occurrences; use a targeted read covering exactly one occurrence or provide its exact 1-indexed expectedLine.`,
        });
      }
      const expanded = uniquelyExpandEdit(
        content,
        {
          oldText,
          newText: normalizeEvidenceText(edit.newText),
          expectedLine: edit.expectedLine,
        },
        selectedOffset,
      );
      if (!expanded) {
        throw guardFailure({
          ok: false,
          category: "EDIT_TARGET_AMBIGUOUS",
          operation: "edit",
          target,
          retryable: true,
          stateChanged: false,
          cause: `edits[${index}] could not be expanded to bounded unique context.`,
        });
      }
      prepared.push(expanded);
    }
    if (missing.length > 0) {
      const cause = hasPriorFileEvidence
        ? `Prior-turn evidence exists for this exact target, but it does not cover every required oldText occurrence. Missing evidence for edit index(es): ${missing.join(", ")}. Read the reported target range, then retry.`
        : `No prior-turn read or bounded mutation snapshot is stored for this exact target. Evidence is file-specific: a successful edit or write of another file does not qualify. Read this target, then retry; missing edit index(es): ${missing.join(", ")}.`;
      throw guardFailure({
        ok: false,
        category: "READ_REQUIRED",
        operation: "edit",
        target,
        retryable: true,
        stateChanged: false,
        cause,
      });
    }
    const estimatedChangedBytes = this.#assertEditBudget(target, prepared);
    const reservationId = this.#reserveMutation(
      turnGeneration,
      canonicalPath,
      "edit",
      prepared.length,
      estimatedChangedBytes,
    );
    return {
      target,
      replacements: prepared.length,
      omittedNoOpEdits: edits.length - effectiveEdits.length,
      estimatedChangedBytes,
      edits: prepared,
      reservationId,
    };
  }

  #assertEditBudget(
    target: string,
    edits: readonly { oldText: string; newText: string }[],
  ): number {
    const estimatedChangedBytes = editScopeBytes(edits);
    if (edits.length > MAX_EDIT_REPLACEMENTS || estimatedChangedBytes > MAX_EDIT_SCOPE_BYTES) {
      throw guardFailure({
        ok: false,
        category: "MUTATION_BUDGET_EXCEEDED",
        operation: "edit",
        target,
        retryable: true,
        stateChanged: false,
        cause: `Requested ${edits.length} replacement(s) and ${estimatedChangedBytes} scoped byte(s); allowed ${MAX_EDIT_REPLACEMENTS} replacement(s) and ${MAX_EDIT_SCOPE_BYTES} scoped byte(s).`,
      });
    }
    return estimatedChangedBytes;
  }

  async writeEditContent(
    cwd: string,
    path: string,
    previousContent: Uint8Array,
    content: string,
    reservationId?: number,
    pathApproval?: MutationPathApproval,
  ): Promise<string> {
    await this.#assertMutationPathAllowed(cwd, path, "edit", pathApproval);
    const absolutePath = await canonicalExistingPath(resolveToolPath(cwd, path));
    const target = displayPath(cwd, absolutePath);
    const previousSha256 = sha256(previousContent);
    const currentSha256 = await hashFile(absolutePath);
    if (currentSha256 !== previousSha256) {
      await this.invalidate(cwd, path);
      this.releaseMutation(reservationId);
      throw guardFailure({
        ok: false,
        category: "STALE_STATE",
        operation: "edit",
        target,
        retryable: true,
        stateChanged: false,
        expectedSha256: previousSha256,
        actualSha256: currentSha256,
      });
    }
    try {
      await writeFile(absolutePath, content, "utf8");
    } catch (error) {
      let afterSha256: string | undefined;
      try {
        afterSha256 = await hashFile(absolutePath);
      } catch {
        // Preserve the original failure if post-state inspection also fails.
      }
      const stateChanged = afterSha256 === undefined || afterSha256 !== previousSha256;
      if (stateChanged) await this.invalidate(cwd, path);
      else this.releaseMutation(reservationId);
      throw guardFailure({
        ok: false,
        category: stateChanged ? "PARTIAL_MUTATION" : "EDIT_FAILED",
        operation: "edit",
        target,
        retryable: !stateChanged,
        stateChanged,
        expectedSha256: previousSha256,
        actualSha256: afterSha256,
        cause: errorMessage(error),
      });
    }
    return previousSha256;
  }

  async partialEditFailure(cwd: string, path: string, cause: string): Promise<never> {
    const absolutePath = resolveToolPath(cwd, path);
    await this.invalidate(cwd, path);
    throw guardFailure({
      ok: false,
      category: "PARTIAL_MUTATION",
      operation: "edit",
      target: displayPath(cwd, absolutePath),
      retryable: false,
      stateChanged: true,
      cause,
    });
  }

  async write(
    cwd: string,
    path: string,
    content: string,
    turnGeneration: number,
    signal?: AbortSignal,
    pathApproval?: MutationPathApproval,
  ): Promise<MutationWriteSuccess> {
    if (signal?.aborted) throw new Error("Operation aborted");
    await this.#assertMutationPathAllowed(cwd, path, "write", pathApproval);
    const targetKey = resolveToolPath(cwd, path);
    const reservationId = this.#reserveMutation(
      turnGeneration,
      targetKey,
      "write",
      0,
      Buffer.byteLength(content, "utf8"),
    );
    try {
      return await this.#writeReserved(cwd, path, content, turnGeneration, signal, pathApproval);
    } catch (error) {
      if (!mutationStateChanged(error)) this.releaseMutation(reservationId);
      throw error;
    }
  }

  async #writeReserved(
    cwd: string,
    path: string,
    content: string,
    turnGeneration: number,
    signal?: AbortSignal,
    pathApproval?: MutationPathApproval,
  ): Promise<MutationWriteSuccess> {
    const absolutePath = resolveToolPath(cwd, path);
    const target = displayPath(cwd, absolutePath);
    if (signal?.aborted) throw new Error("Operation aborted");

    if (await pathExists(absolutePath)) {
      const canonicalPath = await realpath(absolutePath);
      const current = await readFile(canonicalPath);
      const actualSha256 = sha256(current);
      const expected = this.#evidence.get(canonicalPath);

      if (!expected || expected.turnGeneration >= turnGeneration) {
        throw guardFailure({
          ok: false,
          category: "READ_REQUIRED",
          operation: "write",
          target,
          retryable: true,
          stateChanged: false,
          actualSha256,
          cause: expected ? "The complete read occurred in the current tool round; the model has not observed its result yet." : undefined,
        });
      }
      if (expected.sha256 !== actualSha256) {
        this.#evidence.delete(canonicalPath);
        throw guardFailure({
          ok: false,
          category: "STALE_STATE",
          operation: "write",
          target,
          retryable: true,
          stateChanged: false,
          expectedSha256: expected.sha256,
          actualSha256,
        });
      }

      if (signal?.aborted) throw new Error("Operation aborted");
      try {
        await writeFile(canonicalPath, content, "utf8");
      } catch (error) {
        let afterSha256: string | undefined;
        try {
          afterSha256 = await hashFile(canonicalPath);
        } catch {
          // Preserve the original write failure if post-state inspection also fails.
        }
        const stateChanged = afterSha256 === undefined || afterSha256 !== actualSha256;
        throw guardFailure({
          ok: false,
          category: stateChanged ? "PARTIAL_MUTATION" : "WRITE_FAILED",
          operation: "write",
          target,
          retryable: !stateChanged,
          stateChanged,
          expectedSha256: actualSha256,
          actualSha256: afterSha256,
          cause: errorMessage(error),
        });
      } finally {
        this.#evidence.delete(canonicalPath);
      }

      return {
        ok: true,
        mutationReceiptVersion: MUTATION_RECEIPT_VERSION,
        category: "success",
        operation: "write",
        target,
        stateChanged: true,
        previousSha256: actualSha256,
        sha256: sha256(content),
      };
    }

    if (signal?.aborted) throw new Error("Operation aborted");
    const createdDirectoryCandidates = await missingParentDirectories(absolutePath);
    await this.#assertMutationPathAllowed(cwd, path, "write", pathApproval);
    await mkdir(dirname(absolutePath), { recursive: true });
    let verifiedCanonicalTarget: string;
    try {
      verifiedCanonicalTarget = await this.#assertMutationPathAllowed(cwd, path, "write", pathApproval);
    } catch (error) {
      const directoriesRolledBack = await rollbackEmptyDirectories(createdDirectoryCandidates);
      throw guardFailure({
        ok: false,
        category: directoriesRolledBack ? "WRITE_FAILED" : "PARTIAL_MUTATION",
        operation: "write",
        target,
        retryable: directoriesRolledBack,
        stateChanged: !directoriesRolledBack,
        cause: `Parent path changed during creation: ${errorMessage(error)}`,
      });
    }
    await this.#options.beforeExclusiveCreate?.(absolutePath);
    let handle;
    try {
      handle = await open(absolutePath, "wx");
    } catch (error) {
      const directoriesRolledBack = await rollbackEmptyDirectories(createdDirectoryCandidates);
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw guardFailure({
          ok: false,
          category: "TARGET_APPEARED",
          operation: "write",
          target,
          retryable: directoriesRolledBack,
          stateChanged: !directoriesRolledBack,
          cause: directoriesRolledBack ? undefined : "One or more newly created parent directories could not be removed safely.",
        });
      }
      throw guardFailure({
        ok: false,
        category: directoriesRolledBack ? "WRITE_FAILED" : "PARTIAL_MUTATION",
        operation: "write",
        target,
        retryable: directoriesRolledBack,
        stateChanged: !directoriesRolledBack,
        cause: errorMessage(error),
      });
    }

    const createdIdentity = await handle.stat();
    let canonicalAfterCreate: string | undefined;
    try { canonicalAfterCreate = await realpath(absolutePath); } catch { /* handled as identity mismatch below */ }
    if (canonicalAfterCreate !== verifiedCanonicalTarget) {
      await handle.close();
      handle = undefined;
      let fileRemoved = false;
      try {
        const currentIdentity = await stat(absolutePath);
        if (currentIdentity.dev === createdIdentity.dev && currentIdentity.ino === createdIdentity.ino) {
          await rm(absolutePath);
          fileRemoved = true;
        }
      } catch {
        // Never remove a path whose identity cannot be proven.
      }
      const directoriesRolledBack = await rollbackEmptyDirectories(createdDirectoryCandidates);
      const rolledBack = fileRemoved && directoriesRolledBack;
      throw guardFailure({
        ok: false,
        category: rolledBack ? "WRITE_FAILED" : "PARTIAL_MUTATION",
        operation: "write",
        target,
        retryable: rolledBack,
        stateChanged: !rolledBack,
        cause: "Created target no longer matches the final verified canonical path.",
      });
    }

    try {
      if (signal?.aborted) throw new Error("Operation aborted");
      await handle.writeFile(content, "utf8");
    } catch (error) {
      await handle.close().catch(() => undefined);
      handle = undefined;
      let fileRemoved = false;
      try {
        const currentIdentity = await stat(absolutePath);
        if (currentIdentity.dev === createdIdentity.dev && currentIdentity.ino === createdIdentity.ino) {
          await rm(absolutePath);
          fileRemoved = true;
        }
      } catch {
        // Report a residual partial file instead of deleting an unproven path.
      }
      const directoriesRolledBack = await rollbackEmptyDirectories(createdDirectoryCandidates);
      const rolledBack = fileRemoved && directoriesRolledBack;
      throw guardFailure({
        ok: false,
        category: rolledBack ? "WRITE_FAILED" : "PARTIAL_MUTATION",
        operation: "write",
        target,
        retryable: rolledBack,
        stateChanged: !rolledBack,
        cause: errorMessage(error),
      });
    } finally {
      await handle?.close();
    }

    return {
      ok: true,
      mutationReceiptVersion: MUTATION_RECEIPT_VERSION,
      category: "success",
      operation: "write",
      target,
      stateChanged: true,
      created: true,
      sha256: sha256(content),
    };
  }
}
