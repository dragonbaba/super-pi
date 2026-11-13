import { createHash, randomUUID } from "node:crypto";
import type { ExtensionContext, ExtensionRuntime } from "../extensions/types.ts";
import type { WorkspaceSandboxBackend } from "../sandbox/workspace-backend.ts";
import { workspaceInput } from "../sandbox/workspace-paths.ts";
import type { RunSandboxFilePhase } from "./file-sandbox-service.ts";
import type { FileRpcEnvelope } from "./file-rpc-chunks.ts";
import { fileChangeObservationTargets, acceptFileChangeObservations, type ObservationPermissions } from "./changes.ts";
import { FILE_RPC_REQUEST_BYTES } from "./file-operation-limits.mjs";
import { validFileIdentity } from "./file-workspace-path.mjs";

const REPLY_FIELDS = new Set(["version", "rpc", "id", "requestHash", "generation", "wireHash", "ok", "observations", "error"]);
const OBSERVATION_FIELDS = new Set(["path", "exists", "identity", "sha256", "hashOmitted"]);
function fields(value: any, allowed: ReadonlySet<string>) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("[FILE_OBSERVATION] Invalid reply object.");
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error("[FILE_OBSERVATION] Unexpected observation field.");
}

export async function observeSandboxFileChange(backend: WorkspaceSandboxBackend, run: RunSandboxFilePhase, runtime: ExtensionRuntime,
  shutdown: AbortSignal, ctx: ExtensionContext, record: Parameters<NonNullable<ObservationPermissions["observeFileChange"]>>[1]) {
  const boundary = runtime.executionBoundary, generation = boundary.generation, session = ctx.sessionManager.getSessionId();
  const signal = AbortSignal.any(ctx.signal ? [ctx.signal, boundary.signal, shutdown] : [boundary.signal, shutdown]);
  const targets = fileChangeObservationTargets(record), paths = []; for (const target of targets) paths.push(target.path);
  const lease = await runtime.nativePermissions!.authorizeFileObservation(ctx, paths);
  const current = () => { runtime.assertActive(); boundary.assertCurrent(generation); signal.throwIfAborted(); lease.assertCurrent();
    if (ctx.sessionManager.getSessionId() !== session) throw new Error("[STALE_STATE] Observation session changed."); };
  await lease(); current();
  return run(signal, async () => {
    const context = await backend.openFileRpc(signal); current();
    const projected = [], hash = createHash("sha256");
    for (const target of targets) {
      const input = workspaceInput(context.workspaces[0], "read", { path: target.path }, context.workspaces.slice(1));
      projected.push({ path: input.path, workspaceIndex: input.workspaceIndex ?? 0, hash: target.hash }); hash.update(target.path).update(target.hash ? "1" : "0");
    }
    const envelope: FileRpcEnvelope = { ...context, id: randomUUID().replaceAll("-", ""), operation: "file_observe", callId: "changes-observe", requestHash: hash.digest("hex"), generation };
    const serialized = JSON.stringify({ ...envelope, version: 1, rpc: "file-observation-v1", targets: projected }), bytes = Buffer.byteLength(serialized);
    if (bytes > FILE_RPC_REQUEST_BYTES) throw new Error("[FILE_OBSERVATION] Observation scope exceeds its byte budget.");
    const wireHash = createHash("sha256").update(serialized).digest("hex");
    const reply: any = await backend.invokeFileRpc(context, envelope, { serialized, bytes, hash: wireHash, baseBytes: bytes }, signal);
    current(); await lease(); current(); fields(reply, REPLY_FIELDS);
    if (reply.version !== 1 || reply.rpc !== "file-observation-v1" || reply.id !== envelope.id || reply.generation !== generation
      || reply.requestHash !== envelope.requestHash || reply.wireHash !== wireHash || reply.ok !== true
      || reply.error !== undefined || !Array.isArray(reply.observations) || reply.observations.length !== targets.length)
      throw new Error("[FILE_OBSERVATION] Incomplete or unpaired sandbox observation.");
    for (const value of reply.observations) {
      fields(value, OBSERVATION_FIELDS);
      if (value.identity !== undefined && !validFileIdentity(value.identity, true)) throw new Error("[FILE_OBSERVATION] Invalid object identity.");
    }
    return acceptFileChangeObservations(record, reply.observations);
  });
}
