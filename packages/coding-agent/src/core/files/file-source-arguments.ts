import { validateToolArguments } from "@super-pi/ai";
import { Value } from "typebox/value";
import { FileBatchParameters } from "./file-batch-protocol.ts";
import { CopyParameters, DeleteParameters, MoveParameters } from "./file-operation-input.ts";
import { NativeWriteParameters, PublicEditParameters, SandboxWriteParameters, SandboxEditParameters } from "./file-parameters.ts";
import { SHA256_PATTERN } from "./regex.ts";

/** Match the dispatcher's existing bounded schema repair when binding the
 * persisted original call. Valid inputs retain their original field container.
 * No additional conversion rule, payload log or authorization is introduced. */
export function fileSourceArguments(name: string, input: any): any {
  const sandbox = typeof input?.snapshot === "string" && SHA256_PATTERN.test(input.snapshot);
  const parameters = name === "file_batch" ? FileBatchParameters : name === "copy" ? CopyParameters : name === "delete" ? DeleteParameters
    : name === "move" ? MoveParameters : name === "write" ? sandbox ? SandboxWriteParameters : NativeWriteParameters
    : name === "edit" ? sandbox ? SandboxEditParameters : PublicEditParameters : undefined;
  if (!parameters) throw new Error("[FILE_RESULT_INVALID] Unknown original file operation.");
  if (Value.Check(parameters, input)) return input;
  return validateToolArguments({ name, description: "File source call", parameters }, { type: "toolCall", id: "file-source", name, arguments: input });
}
