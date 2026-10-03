import { FileAuthStorageBackend } from "../../packages/coding-agent/src/core/auth-storage.ts";

// The caller provides its owned temporary auth file. Never use the default credential path.
if (!process.argv[2]) throw new Error("Expected an isolated fixture path");
await new FileAuthStorageBackend(process.argv[2]).withLockAsync(async text => {
  const data = JSON.parse(text ?? "{}");
  data.crossProcess = { reviewMarker: "committed" };
  return { result: undefined, next: JSON.stringify(data) };
});
