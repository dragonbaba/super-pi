import type { OwnedProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const openAIResponsesApi = (): OwnedProviderStreams =>
	lazyApi(() => import("./openai-responses.ts"), "mutation-with-generation");
