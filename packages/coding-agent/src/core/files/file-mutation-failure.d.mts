export class FileAuthorityError extends Error { readonly stopInvocation: true; constructor(message: string); }
export function fileInvocationMustStop(error: unknown): boolean;
export function assertFilePathAuthority(expected: { readonly canonical: string; readonly symbolicLink?: boolean }, observed: { readonly canonical: string; readonly symbolicLink?: boolean }): void;
