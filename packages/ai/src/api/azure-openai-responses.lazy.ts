import type { OwnedProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const azureOpenAIResponsesApi = (): OwnedProviderStreams =>
	lazyApi(() => import("./azure-openai-responses.ts"), "mutation-with-generation");
