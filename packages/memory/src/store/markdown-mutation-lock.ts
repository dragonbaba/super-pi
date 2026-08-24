import * as path from "node:path";
import { AtomicLockCoordinator, type AtomicLockLease } from "./atomic-lock-coordinator.js";
import { canonicalStoragePath } from "./canonical-storage-path.js";

const MUTATION_WAIT_MS = 5_000;
const MUTATION_STALE_MS = 300_000;

export async function canonicalMarkdownIdentity(filePath: string): Promise<string> {
  return canonicalStoragePath(filePath);
}

export async function acquireMarkdownMutationLock(
  filePath: string,
  options: { staleMs?: number } = {},
): Promise<AtomicLockLease> {
  const identity = await canonicalMarkdownIdentity(filePath);
  const coordinatorDir = path.dirname(path.dirname(identity));
  const coordinator = AtomicLockCoordinator.shared(path.join(coordinatorDir, ".pi-hermes-locks.sqlite"));
  const lockKey = `mutation:${identity}`;
  const deadline = Date.now() + MUTATION_WAIT_MS;
  const staleMs = options.staleMs ?? MUTATION_STALE_MS;
  let lease = coordinator.tryAcquire(lockKey, { staleMs });

  while (!lease) {
    if (Date.now() >= deadline) {
      throw new Error(`Memory mutation already in progress for ${identity}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    lease = coordinator.tryAcquire(lockKey, { staleMs });
  }

  return lease;
}

export async function withMarkdownMutationLock<T>(
  filePath: string,
  operation: () => Promise<T> | T,
  options: { staleMs?: number } = {},
): Promise<T> {
  const lease = await acquireMarkdownMutationLock(filePath, options);
  try {
    return await operation();
  } finally {
    lease.release();
  }
}
