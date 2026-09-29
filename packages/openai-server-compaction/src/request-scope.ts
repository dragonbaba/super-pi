import { createHash } from "node:crypto";
import type { Model, ProviderHeaders } from "@super-pi/ai";
import { isRecord } from "./config.ts";

/** Request-boundary identity only. Persist a digest, never credentials or account claims. */
export function requestScope(model: Model<any>, apiKey: string | undefined, headers?: ProviderHeaders): string | undefined {
  if (!apiKey) return undefined;
  let identity = apiKey;
  if (model.api === "openai-codex-responses") {
    try {
      const claims: unknown = JSON.parse(Buffer.from(apiKey.split(".")[1] ?? "", "base64url").toString("utf8"));
      if (!isRecord(claims)) return undefined;
      const auth = claims["https://api.openai.com/auth"];
      if (!isRecord(auth) || typeof auth.chatgpt_account_id !== "string" || !auth.chatgpt_account_id) return undefined;
      identity = JSON.stringify([auth.chatgpt_account_id, typeof claims.sub === "string" ? claims.sub : null]);
    } catch { return undefined; }
  }
  const routing = new Headers();
  for (const source of [model.headers, headers]) {
    if (!source) continue;
    for (const name of Object.keys(source)) {
      const key = name.toLowerCase();
      if (key !== "openai-organization" && key !== "openai-project" && key !== "chatgpt-account-id") continue;
      const value = source[name];
      if (value === null) routing.delete(key);
      else if (value !== undefined) routing.set(key, value);
    }
  }
  const endpoint = (model.baseUrl?.trim() || (model.api === "openai-codex-responses"
    ? "https://chatgpt.com/backend-api" : "https://api.openai.com/v1")).replace(/\/+$/, "");
  return createHash("sha256").update(JSON.stringify([
    model.provider, model.api, endpoint, identity,
    routing.get("openai-organization"), routing.get("openai-project"), routing.get("chatgpt-account-id"),
  ])).digest("hex");
}
