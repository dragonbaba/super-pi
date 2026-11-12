import { realpath } from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";

const fileMutationQueues = new Map<string, Promise<void>>();
let registrationQueue = Promise.resolve();

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

async function getMutationQueueKey(filePath: string): Promise<string> {
    const resolvedPath = resolve(filePath);
    let probe = resolvedPath;
    for (;;) {
        try {
            const ancestor = await realpath(probe);
            const key = resolve(ancestor, relative(probe, resolvedPath));
            return process.platform === "win32" ? key.toLowerCase() : key;
        } catch (error) {
            if (!isMissingPathError(error)) throw error;
            const parent = dirname(probe);
            if (parent === probe) throw error;
            probe = parent;
        }
    }
}

/**
 * Serialize file mutation operations targeting the same file.
 * Operations for different files still run in parallel.
 */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
    return withFileMutationQueues([filePath], fn);
}

function registrationFinished(): void {}

/** Reserve every path together before waiting. Edges only point to older owners,
 * so overlapping calls cannot deadlock and need no recursive lock callbacks.
 * Arrays, deferred and callbacks belong to this invocation's lock setup. */
class MutationQueueRegistration {
    readonly paths: readonly string[];
    readonly keys: string[] = [];
    readonly predecessors: Promise<void>[] = [];
    readonly barrier: Promise<void>;
    private releaseNext!: () => void;
    constructor(paths: readonly string[]) {
        this.paths = paths;
        this.barrier = new Promise<void>(this.bindRelease);
    }
    private readonly bindRelease = (release: () => void): void => { this.releaseNext = release; };
    readonly register = async (): Promise<void> => {
        const keys = new Set<string>();
        // Resolve all names before publishing any reservation: failure has no lock side effects.
        for (const path of this.paths) keys.add(await getMutationQueueKey(path));
        for (const key of keys) this.keys.push(key);
        this.keys.sort();
        const predecessors = new Set<Promise<void>>();
        for (const key of this.keys) {
            const previous = fileMutationQueues.get(key);
            if (previous) predecessors.add(previous);
            fileMutationQueues.set(key, this.barrier);
        }
        for (const previous of predecessors) this.predecessors.push(previous);
    };
    release(): void {
        this.releaseNext();
        for (const key of this.keys) if (fileMutationQueues.get(key) === this.barrier) fileMutationQueues.delete(key);
        this.keys.length = 0; this.predecessors.length = 0;
    }
}

export async function withFileMutationQueues<T>(paths: readonly string[], fn: () => Promise<T>): Promise<T> {
    const owner = new MutationQueueRegistration(paths);
    const registration = registrationQueue.then(owner.register);
    registrationQueue = registration.then(registrationFinished, registrationFinished);
    try {
        await registration;
        for (const previous of owner.predecessors) await previous;
        owner.predecessors.length = 0;
        return await fn();
    } finally { owner.release(); }
}
