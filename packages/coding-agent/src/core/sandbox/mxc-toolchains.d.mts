export class SandboxToolchains {
  constructor(options: { cwd: string; settings?: { include?: string[]; exclude?: string[] }; powershellPath?: string; environment?: NodeJS.ProcessEnv; executable?: string; home?: string; io?: unknown });
  readonly hostShell: string;
  readonly shell: string;
  readonly mountRoots: string[];
  readonly environment: Record<string, string>;
  readonly statistics: { roots: number; paths: number };
  readonly diagnostics: unknown[];
  assertCurrent(): void;
}
