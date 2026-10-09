import { FileAuthStorageBackend } from "../../packages/coding-agent/src/core/auth-storage.ts";

const [path, key, action] = process.argv.slice(2);
if (!path || !key || !["login", "logout"].includes(action) || !process.send) throw new Error("Expected isolated transaction fixture arguments and IPC");
process.send({ type: "waiting" });
const refresh = await new FileAuthStorageBackend(path).withLockAsync(async text => {
  const store = JSON.parse(text ?? "{}");
  const current = store[key];
  const observed = current?.refresh ?? current?.tokens?.refresh_token;
  if (action === "logout") delete store[key];
  else if (current?.type === "oauth") store[key] = { ...current, access: "access-login", refresh: "refresh-login", expires: Date.now() + 3_600_000 };
  else store[key] = { ...current, tokens: { ...current.tokens, access_token: "access-login", refresh_token: "refresh-login" }, expiresAt: Date.now() + 3_600_000 };
  return { result: observed, next: JSON.stringify(store) };
});
process.send({ type: "committed", refresh });
process.disconnect();
