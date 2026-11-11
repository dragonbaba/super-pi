import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isUtf8 } from "node:buffer";
import type { TestContext } from "node:test";
import ts from "typescript";
import { WorkspaceOperationError } from "../../packages/coding-agent/src/core/sandbox/workspace-backend.ts";
import type { WorkspaceSandboxTools } from "../../packages/coding-agent/src/core/sandbox/workspace-tools.ts";
import { workspaceInput } from "../../packages/coding-agent/src/core/sandbox/workspace-paths.ts";
import { detectSupportedImageMimeType, IMAGE_TYPE_SNIFF_BYTES } from "../../packages/coding-agent/src/utils/image-signature.mjs";
import { removeOwnedFixture } from "./owned-fixture-cleanup.ts";
import * as limits from "../../packages/coding-agent/src/core/sandbox/mxc-file-limits.mjs";

// Exercise the actual controlled worker without claiming this fixture proves OS isolation.
const source = ts.createSourceFile("worker.mjs", fs.readFileSync("packages/coding-agent/src/core/sandbox/mxc-file-worker.mjs", "utf8"), ts.ScriptTarget.Latest, true);
const body = "const { FILE_LIMIT, IMAGE_LIMIT, READ_LINES, SEARCH_ROWS, SEARCH_ENTRIES, TEXT_LIMIT, SEARCH_EXCERPT, SEARCH_CLIPPED_MARK, normalizeReadOffset, normalizeReadLimit } = limits;\n"
  + source.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(source)).join("\n");
const execute = new Function("fs", "path", "createHash", "randomUUID", "isUtf8", "process", "console", "detectSupportedImageMimeType", "IMAGE_TYPE_SNIFF_BYTES", "limits", body);

export function mxcFileFixture(t: TestContext, temporary = os.tmpdir()) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(temporary, "mxc-file-")));
  const input = path.join(root, "project"), additional = path.join(root, "additional"), runtime = path.join(root, "runtime");
  const exchange = path.join(runtime, "exchange"), requestFile = path.join(runtime, "request.json");
  for (const directory of [input, additional, runtime, exchange]) fs.mkdirSync(directory);
  let cleanup: (() => Promise<void>) | undefined;
  t.after(async () => { await cleanup?.(); removeOwnedFixture(root); });
  function invoke(operation: string, args: Record<string, unknown>, mode = "sandbox-write", io = fs): any {
    const inputArgs = workspaceInput(input, operation, args, [additional]);
    fs.writeFileSync(requestFile, JSON.stringify({ id: randomUUID().replaceAll("-", ""), workspaces: [input, additional],
      exchange, mode, operation, input: inputArgs, maxWriteBytes: 1024 * 1024 }));
    let reply: any;
    execute(io, path, createHash, randomUUID, isUtf8, { argv: ["node", "worker", requestFile], exitCode: 0 },
      { log(text: string) { reply = JSON.parse(text); } }, detectSupportedImageMimeType, IMAGE_TYPE_SNIFF_BYTES, limits);
    return reply;
  }
  function attach(owner: WorkspaceSandboxTools, mode: string) {
    cleanup = () => owner.close();
    const backend = (owner as any).backend;
    const stat = fs.lstatSync(runtime, { bigint: true });
    backend.root = runtime; backend.identity = stat.dev + ":" + stat.ino; backend.exchange = exchange;
    backend.invoke = async (operation: string, args: Record<string, unknown>) => {
      const reply = invoke(operation, args, mode);
      if (!reply.ok) throw new WorkspaceOperationError(reply);
      if (reply.image) backend.artifacts.add(reply.image.artifact.name);
      return reply;
    };
    return backend;
  }
  return { root, input, additional, runtime, exchange, invoke, attach,
    cleanupWith(close: () => Promise<void>) { cleanup = close; } };
}
