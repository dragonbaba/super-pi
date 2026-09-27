export function captureBuiltArtifacts(project: string): { lockfileSha256: string; files: { path: string; bytes: number; sha256: string }[]; sha256: string };
