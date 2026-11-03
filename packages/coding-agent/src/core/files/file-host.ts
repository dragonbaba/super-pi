import type { ExtensionAPI } from "../extensions/types.ts";
import type { SessionFiles } from "./session-files.ts";

export const FILE_OWNER_EVENT = "super-pi:native-file-owner";
export const NATIVE_FILE_REVISION = Symbol("native-file-read-revision");

/** Optional compatibility discovery. No fallback owner and no process-global file state. */
export function getSessionFiles(host: Pick<ExtensionAPI, "events">): SessionFiles | undefined {
  const request: { owner?: SessionFiles } = {};
  host.events?.emit(FILE_OWNER_EVENT, request);
  return request.owner;
}
