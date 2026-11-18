import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const LOCAL_SEARCH_BASE = "http://127.0.0.1:8888";
export const LOCAL_SEARCH_ENDPOINT = LOCAL_SEARCH_BASE + "/search";

export function localInstallRoot(): string | undefined {
  const appData = process.env.LOCALAPPDATA;
  return appData && isAbsolute(appData) ? join(appData, "SuperPi", "SearXNG") : undefined;
}

export function hasLocalInstallation(): boolean {
  const root = localInstallRoot();
  return !!root && existsSync(join(root, "install.json"));
}
