import type { OwnedProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const mistralConversationsApi = (): OwnedProviderStreams =>
	lazyApi(() => import("./mistral-conversations.ts"), "mutation-with-generation");
