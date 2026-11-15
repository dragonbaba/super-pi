/** Shared host/worker failure provenance. No filesystem or mutable module state. */
export class FileAuthorityError extends Error {
  stopInvocation = true;
  constructor(message) { super('[STALE_STATE] ' + message); this.name = 'FileAuthorityError'; }
}

/** Compare already observed identities; never allocate or resolve a path here. */
export function assertFilePathAuthority(expected, canonical, symbolicLink = false) {
  if (expected.canonical !== canonical || Boolean(expected.symbolicLink) !== symbolicLink) throw new FileAuthorityError('Prepared file path was retargeted.');
}

export function fileInvocationMustStop(error) {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return error instanceof Error && error.stopInvocation === true
    || message.startsWith('[FILE_RPC_') || message.startsWith('[FILE_RESULT_') || message.startsWith('[FILE_MANIFEST_')
    || message.startsWith('[EXECUTION_') || message.startsWith('[POLICY_BLOCKED]')
    || message.startsWith('[SANDBOX_') || error instanceof Error && error.name === 'AbortError';
}
