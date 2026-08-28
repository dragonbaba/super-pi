import type { OwnedProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const anthropicMessagesApi = (): OwnedProviderStreams =>
	lazyApi(() => import("./anthropic-messages.ts"), "mutation-with-generation");
