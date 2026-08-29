import type { OwnedProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const piMessagesApi = (): OwnedProviderStreams =>
	lazyApi(() => import("./pi-messages.ts"), "replacement-object");
