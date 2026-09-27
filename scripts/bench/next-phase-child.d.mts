export function runMeasuredChild(options: {
  executable: string; args: string[]; project: string; file: string; ledger: string;
  env: NodeJS.ProcessEnv; tag: string; deadlineMs: number; signal?: AbortSignal; inheritStdio?: boolean;
}): Promise<void>;
