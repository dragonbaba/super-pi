import type { OwnedProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const openAICompletionsApi = (): OwnedProviderStreams =>
	lazyApi(() => import("./openai-completions.ts"), "mutation-with-generation");
