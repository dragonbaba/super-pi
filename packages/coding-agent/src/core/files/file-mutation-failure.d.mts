export class FileAuthorityError extends Error { readonly stopInvocation: true; constructor(message: string); }
export function fileInvocationMustStop(error: unknown): boolean;
