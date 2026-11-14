import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AtomicLockCoordinator, type AtomicLockLease } from "./atomic-lock-coordinator.js";
import { canonicalStoragePath } from "./canonical-storage-path.js";

const MUTATION_WAIT_MS = 5_000;
const MUTATION_STALE_MS = 300_000;

interface MarkdownMutationLockOptions {
  staleMs?: number;
  coordinator?: AtomicLockCoordinator;
  signal?: AbortSignal;
}

export async function canonicalMarkdownIdentity(filePath: string): Promise<string> {
  return canonicalStoragePath(filePath);
}

export async function acquireMarkdownMutationLock(
  filePath: string,
  options: MarkdownMutationLockOptions = {},
): Promise<AtomicLockLease> {
  options.signal?.throwIfAborted();
  const identity = await canonicalMarkdownIdentity(filePath);
  options.signal?.throwIfAborted();
  const coordinatorDir = path.dirname(path.dirname(identity));
  const coordinator = options.coordinator ?? AtomicLockCoordinator.shared(path.join(coordinatorDir, ".pi-hermes-locks.sqlite"));
  const lockKey = `mutation:${identity}`;
  const deadline = Date.now() + MUTATION_WAIT_MS;
  const staleMs = options.staleMs ?? MUTATION_STALE_MS;
  let lease = coordinator.tryAcquire(lockKey, { staleMs });

  while (!lease) {
    if (Date.now() >= deadline) {
      throw new Error(`Memory mutation already in progress for ${identity}`);
    }
    await delay(10, undefined, { signal: options.signal });
    options.signal?.throwIfAborted();
    lease = coordinator.tryAcquire(lockKey, { staleMs });
  }

  if (options.signal?.aborted) {
    lease.release();
    options.signal.throwIfAborted();
  }
  return lease;
}

export async function withMarkdownMutationLock<T>(
  filePath: string,
  operation: () => Promise<T> | T,
  options: MarkdownMutationLockOptions = {},
): Promise<T> {
  const lease = await acquireMarkdownMutationLock(filePath, options);
  try {
    options.signal?.throwIfAborted();
    return await operation();
  } finally {
    lease.release();
  }
}
