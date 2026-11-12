import type { BigIntStats } from "node:fs";
import type fs from "node:fs";
import type { PathIdentity } from "./native-file-core.js";
export function publishedDigest(target: string, identity: BigIntStats | PathIdentity, expected: string, size: number, io?: typeof fs): string;
export class MxcFilePublication {
  constructor(target: string, fd: number, before: BigIntStats, previousSha256: string, expectedParent?: BigIntStats | PathIdentity, io?: typeof fs);
  readonly requiresVerification: boolean;
  readonly outcome: "not_committed" | "committed" | "unknown";
  readonly retainedTemporary: string | undefined;
  readonly diagnostics: { sourceHandleRetained: boolean; candidateHandleRetained: boolean; metadataRetained: boolean; ioRetained: boolean };
  commitText(text: string): string;
  commitCopy(source: PathIdentity, expectedHash: string, authority?: () => void, signal?: AbortSignal): Promise<string>;
  dispose(): void;
}
