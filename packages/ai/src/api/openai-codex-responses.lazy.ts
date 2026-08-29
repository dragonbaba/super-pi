import type { OwnedProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const openAICodexResponsesApi = (): OwnedProviderStreams =>
	lazyApi(() => import("./openai-codex-responses.ts"), "mutation-with-generation");
