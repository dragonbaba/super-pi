export const DETACH_UTILITY_PATTERN = /(?:^|[\s;|()])(?:nohup|disown|setsid|daemonize)(?=$|[\s;|()])/iu;
export const WINDOWS_DETACH_PATTERN = /(?:^|[\s;|()])(?:start-process|cmd(?:\.exe)?\s+\/c\s+start)(?=$|[\s;|()])/iu;
export const WINDOWS_START_BACKGROUND_PATTERN = /(?:^|[\s;|()])start\s+(?:"[^"]*"\s+)?\/b(?=$|[\s;|()])/iu;
export const WINDOWS_WAIT_PATTERN = /(?:^|[\s;|()])(?:start-process\b[^\r\n;|]*\s-wait\b|start\b[^\r\n;|]*\s\/wait\b)/iu;
export const SHELL_WAIT_PATTERN = /(?:^|[;&|()\r\n])\s*wait(?=$|[\s;|)])/u;
export const EXIT_TRAP_PATTERN = /(?:^|[;&|()\r\n])\s*trap\b[^\r\n]*(?:EXIT|\b0\b)/iu;
export const PROCESS_CLEANUP_PATTERN = /(?:^|[;&|()\r\n])\s*(?:(?:kill|pkill|taskkill|stop-process)(?=$|[\s;|()])|trap\b\s*['"]\s*(?:kill|pkill|taskkill|stop-process)(?=$|[\s;|()]))/iu;
export const DOCKER_DETACHED_PATTERN = /\bdocker(?:\s+compose)?\b[^;\r\n&|]*(?:\s-d\b|\s--detach\b)/iu;
export const DOCKER_CLEANUP_PATTERN = /(?:^|[;&|()\r\n])\s*(?:sudo\s+)?docker(?:\s+compose)?\b[^;\r\n&|]*(?:\sdown\b|\sstop\b|\srm\b)/iu;
export const SERVICE_START_PATTERN = /(?:^|[;&|()\r\n])\s*(?:sudo\s+)?(?:systemctl\s+start|service\s+\S+\s+start|pm2\s+(?:start|serve))(?=$|[\s;|()])/iu;
export const SERVICE_CLEANUP_PATTERN = /(?:^|[;&|()\r\n])\s*(?:sudo\s+)?(?:systemctl\s+stop|service\s+\S+\s+stop|pm2\s+(?:stop|delete|kill))(?=$|[\s;|()])/iu;

// High-risk mutation primitives from the script-safety policy. Keep these
// module-scoped and non-global so hot-path scans allocate no regular expressions
// and retain no lastIndex state.
export const RM_RECURSIVE_PATTERN = /\brm\b(?=[^;&|\r\n]*(?:\s-[A-Za-z]*r[A-Za-z]*\b|\s--recursive\b))/iu;
export const POWERSHELL_REMOVE_RECURSIVE_PATTERN = /\bremove-item\b(?=[^;&|\r\n]*\s-(?:recurse|r)\b)/iu;
export const WINDOWS_RMDIR_RECURSIVE_PATTERN = /\brmdir\b(?=[^;&|\r\n]*\s\/s\b)/iu;
export const PYTHON_RMTREE_PATTERN = /\bshutil\.rmtree\s*\(/iu;
export const PYTHON_UNLINK_PATTERN = /(?:\bpathlib\.Path\s*\([^)]*\)|\bPath\s*\([^)]*\)|[A-Za-z_$][\w$.[\]]*)\.unlink\s*\(/iu;
export const NODE_RECURSIVE_RM_PATTERN = /\b(?:fs\.)?(?:rm|rmSync)\s*\([^)]*\brecursive\s*:\s*true/iu;
export const NODE_UNLINK_PATTERN = /\b(?:fs\.)?(?:unlink|unlinkSync)\s*\(/iu;
export const FIND_DELETE_PATTERN = /\bfind\b[^;&|\r\n]*\s-delete\b/iu;
export const XARGS_RM_PATTERN = /\bxargs\b[^;&|\r\n]*\brm\b/iu;
export const GIT_CLEAN_PATTERN = /\bgit\s+clean\b(?=[^;&|\r\n]*\s-[A-Za-z]*f[A-Za-z]*\b)(?=[^;&|\r\n]*\s-[A-Za-z]*d[A-Za-z]*\b|[^;&|\r\n]*\s-[A-Za-z]*fd[A-Za-z]*\b)/iu;
export const GIT_RESET_HARD_PATTERN = /\bgit\s+reset\s+--hard\b/iu;
export const PYTHON_LITERAL_TARGET_PATTERN = /(?:shutil\.rmtree|(?:pathlib\.)?Path)\s*\(\s*["']([^"']+)["']/iu;
export const NODE_LITERAL_TARGET_PATTERN = /(?:\b(?:fs\.)?(?:rm|rmSync|unlink|unlinkSync))\s*\(\s*["']([^"']+)["']/iu;
export const LEADING_PATH_SEPARATOR_PATTERN = /^[/\\]+/u;
