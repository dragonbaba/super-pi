import type { OwnedProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const googleGenerativeAIApi = (): OwnedProviderStreams =>
	lazyApi(() => import("./google-generative-ai.ts"), "replacement-object");
