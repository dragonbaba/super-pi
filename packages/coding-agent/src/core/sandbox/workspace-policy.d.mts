export function isVmPrivateName(lowerName: string): boolean;
export function isProtectedWorkspaceName(lowerName: string): boolean;
export function parseSandboxPrivateDirectories(value: unknown): readonly string[];
export function isVmPrivateDirectory(name: string, directories?: readonly string[]): boolean;
export function isVmPrivatePath(name: string, directories?: readonly string[]): boolean;
