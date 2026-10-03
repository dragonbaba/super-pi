import { createAgentSession, type CreateAgentSessionOptions } from "../../packages/coding-agent/src/core/sdk.ts";
import { exposeNativeProtocolForFixture } from "./next-phase-model.ts";
export { exposeNativeProtocolForFixture } from "./next-phase-model.ts";

export async function createNativeProtocolSessionFixture(options: CreateAgentSessionOptions) {
  const result = await createAgentSession(options);
  exposeNativeProtocolForFixture(result.session);
  return result;
}
