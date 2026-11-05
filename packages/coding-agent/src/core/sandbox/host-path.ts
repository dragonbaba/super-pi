/** Only PATH is refreshed. Explicit process entries retain precedence over newly installed persistent entries. */
export function mergeHostPath(processPath: string, persistent: unknown): string {
  if (!Array.isArray(persistent) || persistent.length !== 2) throw new Error("Invalid persistent PATH response");
  const seen = new Set<string>(), entries: string[] = [];
  for (const value of [processPath, ...persistent]) {
    if (value === null) continue;
    if (typeof value !== "string" || value.length > 32768 || value.includes("\0")) throw new Error("Invalid persistent PATH value");
    for (const raw of value.split(";")) {
      const entry = raw.trim(), key = entry.toLowerCase();
      if (!entry || seen.has(key)) continue;
      seen.add(key); entries.push(entry);
      if (entries.length > 512) throw new Error("Host PATH exceeds 512 directories");
    }
  }
  return entries.join(";");
}

export function refreshedHostEnvironment(environment: NodeJS.ProcessEnv, persistent: unknown): NodeJS.ProcessEnv {
  let processPath = "";
  const keys = Object.keys(environment);
  for (const key of keys) if (key.toUpperCase() === "PATH") { processPath = environment[key] ?? ""; break; }
  const merged = mergeHostPath(processPath, persistent), result: NodeJS.ProcessEnv = { ...environment, PATH: merged };
  for (const key of keys) if (key.toUpperCase() === "PATH") result[key] = merged;
  return result;
}

export const HOST_PATH_QUERY = "if($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -ne 7){throw 'PowerShell 7 required'};"
  + "$values=@([Environment]::ExpandEnvironmentVariables([string][Environment]::GetEnvironmentVariable('PATH','Machine')),[Environment]::ExpandEnvironmentVariables([string][Environment]::GetEnvironmentVariable('PATH','User')));"
  + "[Console]::Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $values -Compress))))";
