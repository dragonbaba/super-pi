import type { OwnedProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const googleVertexApi = (): OwnedProviderStreams =>
	lazyApi(() => import("./google-vertex.ts"), "replacement-object");
