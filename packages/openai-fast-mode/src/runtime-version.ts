import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const SP_PACKAGE_NAME = "@super-pi/coding-agent";
const MAX_PACKAGE_JSON_BYTES = 64 * 1024;
const MAX_PARENT_DEPTH = 12;

export function discoverActivePiVersion(entry = process.argv[1]): string | undefined {
  if (!entry) return undefined;
  let directory: string;
  try {
    directory = dirname(realpathSync(entry));
  } catch {
    return undefined;
  }
  for (let depth = 0; depth < MAX_PARENT_DEPTH; depth++) {
    const metadataPath = join(directory, "package.json");
    try {
      if (existsSync(metadataPath)) {
        const stat = statSync(metadataPath);
        if (stat.isFile() && stat.size > 0 && stat.size <= MAX_PACKAGE_JSON_BYTES) {
          const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
          if (metadata.name === SP_PACKAGE_NAME && typeof metadata.version === "string") return metadata.version;
        }
      }
    } catch {
      return undefined;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}
