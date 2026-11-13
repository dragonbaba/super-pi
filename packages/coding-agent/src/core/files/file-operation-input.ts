import { Type } from "typebox";
import { Value } from "typebox/value";
import { UNSAFE_NATIVE_PATH_PATTERN } from "./regex.ts";
import { WINDOWS_BATCH_COMPONENT_PATTERN, WINDOWS_PATH_SEPARATOR_PATTERN } from "./regex.ts";
import { parse } from "node:path";

export type NativeFileOperation = "copy" | "delete" | "move";
const Path = Type.String({ minLength: 1, maxLength: 4096 });
const Destination = Type.String({ minLength: 1, maxLength: 4096, description: "Destination parent directory must already exist. Missing parents return destination_parent_missing; create them with the authorized shell before retrying." });
const Purpose = Type.Optional(Type.String({ maxLength: 800 }));
const DryRun = Type.Optional(Type.Boolean({ description: "Read-only whole-call preflight; apply always prepares again and requires current authorization." }));
const Pair = Type.Object({ path: Path, destination: Destination }, { additionalProperties: false });
const Recursive = Type.Optional(Type.Boolean({ description: "Required to remove a nonempty directory. Links are removed without following their targets." }));
const Overwrite = Type.Optional(Type.Boolean({ description: "Replace an existing ordinary file through the metadata commit owner. Directories are never overwritten or merged." }));
const PAIR_FORMS = [
  { required: ["path", "destination"], not: { required: ["items"] } },
  { required: ["items"], not: { anyOf: [{ required: ["path"] }, { required: ["destination"] }] } },
];
// Typed fields stay at the root so the existing bounded argument repair can
// resolve their schema; anyOf enforces mutually exclusive scalar/array forms.
export const CopyParameters = Type.Object({ path: Type.Optional(Path), destination: Type.Optional(Destination),
  items: Type.Optional(Type.Array(Pair, { minItems: 1 })), overwrite: Overwrite, dryRun: DryRun, purpose: Purpose }, { additionalProperties: false, anyOf: PAIR_FORMS });
export const DeleteParameters = Type.Object({ path: Type.Optional(Path), paths: Type.Optional(Type.Array(Path, { minItems: 1 })),
  recursive: Recursive, dryRun: DryRun, purpose: Purpose }, { additionalProperties: false, anyOf: [
    { required: ["path"], not: { required: ["paths"] } }, { required: ["paths"], not: { required: ["path"] } },
  ] });
export const MoveParameters = Type.Object({ path: Type.Optional(Path), destination: Type.Optional(Destination),
  items: Type.Optional(Type.Array(Pair, { minItems: 1 })), dryRun: DryRun, purpose: Purpose }, { additionalProperties: false, anyOf: PAIR_FORMS });
export interface NativeFileItemInput { path: string; destination?: string; purpose?: string; recursive?: boolean; overwrite?: boolean; }
export interface NativeFileInvocationInput {
  path?: string; destination?: string; paths?: string[]; items?: Array<{ path: string; destination: string }>;
  recursive?: boolean; overwrite?: boolean; dryRun?: boolean; purpose?: string;
}
export interface NativeFileInput {
  readonly items: readonly Readonly<NativeFileItemInput>[];
  readonly arrayMode: boolean; readonly dryRun: boolean; readonly purpose?: string;
}
const NATIVE_KEYS = new Set(["path", "destination", "paths", "items", "recursive", "overwrite", "dryRun", "purpose"]);
const PAIR_KEYS = new Set(["path", "destination"]);
function dataFields(value: unknown, allowed: ReadonlySet<string>): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("[TOOL_ARGS_INVALID] Expected a plain parameter object.");
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!allowed.has(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value")) throw new Error("[TOOL_ARGS_INVALID] Unexpected or accessor parameter field.");
  }
}
function path(value: unknown): void {
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || UNSAFE_NATIVE_PATH_PATTERN.test(value)) throw new Error("[TOOL_ARGS_INVALID] Expected one literal path of 1-4096 characters.");
  if (process.platform === "win32") for (const component of value.slice(parse(value).root.length).split(WINDOWS_PATH_SEPARATOR_PATTERN)) {
    if (!component || component === "." || component === "..") continue;
    if (WINDOWS_BATCH_COMPONENT_PATTERN.test(component)) throw new Error("[TOOL_ARGS_INVALID] Ambiguous Windows device, stream, trailing-dot or trailing-space path component.");
  }
}
export function nativeItemCount(input: NativeFileInvocationInput): number {
  return input.paths?.length ?? input.items?.length ?? 1;
}
/** Bounded per-item projection; does not copy an invocation's target list. */
export function nativeItemInput(operation: NativeFileOperation, input: NativeFileInvocationInput, index: number): NativeFileItemInput {
  const pair = input.items?.[index];
  const item: NativeFileItemInput = { path: input.paths ? input.paths[index] : pair ? pair.path : input.path! };
  if (operation !== "delete") item.destination = pair ? pair.destination : input.destination;
  if (input.purpose !== undefined) item.purpose = input.purpose;
  if (operation === "delete" && input.recursive !== undefined) item.recursive = input.recursive;
  if (operation === "copy" && input.overwrite !== undefined) item.overwrite = input.overwrite;
  return item;
}
export function validateNativeInvocation(operation: NativeFileOperation, raw: unknown): asserts raw is NativeFileInvocationInput {
  dataFields(raw, NATIVE_KEYS);
  if (Array.isArray(raw.items)) for (const item of raw.items) dataFields(item, PAIR_KEYS);
  const schema = operation === "copy" ? CopyParameters : operation === "delete" ? DeleteParameters : MoveParameters;
  if (!Value.Check(schema, raw)) throw new Error("[TOOL_ARGS_INVALID] Use exactly one scalar target or a nonempty target array; parameters cannot mix forms or operation flags.");
  const input = raw as NativeFileInvocationInput, count = nativeItemCount(input);
  for (let index = 0; index < count; index++) {
    const pair = input.items?.[index];
    path(input.paths ? input.paths[index] : pair ? pair.path : input.path);
    if (operation !== "delete") path(pair ? pair.destination : input.destination);
  }
}
/** One request setup owns the copied immutable list until execution/release. No target count cap. */
export function copyNativeInvocation(operation: NativeFileOperation, raw: unknown): NativeFileInput {
  validateNativeInvocation(operation, raw);
  const items: Readonly<NativeFileItemInput>[] = [], count = nativeItemCount(raw);
  for (let index = 0; index < count; index++) items.push(Object.freeze(nativeItemInput(operation, raw, index)));
  return Object.freeze({ items: Object.freeze(items), arrayMode: raw.paths !== undefined || raw.items !== undefined,
    dryRun: raw.dryRun === true, purpose: raw.purpose });
}
