import { realpathSync } from "node:fs";
import { LspClient } from "./lsp-client.js";
import type { LspServerAdapter } from "./types.js";

const DEFAULT_IDLE_MS = 10 * 60_000;
const FAILURE_BACKOFF_MS = 3 * 60_000;
const MAX_FAILURE_BACKOFFS = 64;
const MAX_CLIENTS = 8;

interface PoolEntry {
	client: LspClient;
	rootKey: string;
	leases: number;
	idleTimer?: NodeJS.Timeout;
	closing?: Promise<void>;
}

interface FailureEntry {
	until: number;
	message: string;
}

interface PoolIdentity {
	key: string;
	rootKey: string;
}

export interface ClientLease {
	key: string;
	client: LspClient;
	reused: boolean;
}

export class LspClientPool {
	#entries = new Map<string, PoolEntry>();
	#initializing = new Map<string, Promise<LspClient>>();
	#workspaceClaims = new Map<string, string>();
	#failures = new Map<string, FailureEntry>();
	#idleMs: number;
	#shuttingDown = false;
	#shutdownOperation?: Promise<void>;

	constructor(idleMs = DEFAULT_IDLE_MS) {
		this.#idleMs = idleMs;
	}

	reopen() {
		if (!this.#shuttingDown) return;
		if (this.#shutdownOperation || this.#initializing.size > 0 || this.#entries.size > 0) {
			throw new Error("Cannot reopen the LSP client pool while shutdown is still draining.");
		}
		this.#shuttingDown = false;
	}

	async acquire(adapter: LspServerAdapter, root: string, timeoutMs: number): Promise<ClientLease> {
		if (this.#shuttingDown) {
			throw new Error(
				"The LSP client pool is shutting down. Retry after session startup completes; run /reload if it persists.",
			);
		}
		const { key, rootKey } = poolIdentity(adapter, root);
		const pending = this.#initializing.get(key);
		if (pending) {
			const client = await pending;
			return this.#checkoutInitialized(key, client, true);
		}
		const existing = this.#entries.get(key);
		if (existing?.closing) throw new Error("The LSP client is still closing.");
		if (existing?.client.running) return this.#checkout(key, existing, true);

		const failure = this.#failures.get(key);
		if (failure && failure.until > Date.now()) {
			throw new Error(`${failure.message} Retry after ${new Date(failure.until).toISOString()}.`);
		}
		this.#failures.delete(key);

		const claimedKey = this.#workspaceClaims.get(rootKey);
		const claimedEntry = claimedKey ? this.#entries.get(claimedKey) : undefined;
		if (claimedKey && claimedKey !== key) {
			if (this.#initializing.has(claimedKey) || (claimedEntry?.leases ?? 0) > 0) {
				throw new Error(
					`LSP server ${serverNameFromKey(claimedKey)} is already active for workspace ${rootKey}. `
					+ `Release its active operation before selecting ${adapter.name}.`,
				);
			}
		}
		if (!this.#workspaceClaims.has(rootKey) && this.#workspaceClaims.size >= MAX_CLIENTS) {
			throw new Error(`The LSP client pool is limited to ${MAX_CLIENTS} workspaces. Close idle services before opening another.`);
		}

		// Reserve the workspace synchronously. A sibling acquire can now only join this
		// exact initialization; a different server is rejected before it can spawn.
		this.#workspaceClaims.set(rootKey, key);
		const superseded = claimedKey ? this.#entries.get(claimedKey) : undefined;
		const supersededEntry = claimedKey && superseded ? { key: claimedKey, entry: superseded } : undefined;
		const initialization = this.#createClient(adapter, root, timeoutMs, { key, rootKey }, supersededEntry);
		this.#initializing.set(key, initialization);
		const client = await initialization;
		return this.#checkoutInitialized(key, client, false);
	}

	release(lease: ClientLease) {
		const entry = this.#entries.get(lease.key);
		if (entry?.client !== lease.client || entry.leases <= 0) return;
		entry.leases -= 1;
		if (entry.leases === 0) this.#scheduleIdle(lease.key, entry);
	}

	async discard(lease: ClientLease) {
		const entry = this.#entries.get(lease.key);
		if (entry?.client === lease.client) await this.#closeEntry(lease.key, entry);
		else await lease.client.shutdown();
	}

	shutdownAll(): Promise<void> {
		this.#shuttingDown = true;
		return this.#shutdownOperation ??= Promise.resolve().then(() => this.#performShutdown());
	}

	async #performShutdown() {
		for (const entry of this.#entries.values()) {
			if (entry.idleTimer) clearTimeout(entry.idleTimer);
			entry.idleTimer = undefined;
		}
		try {
			const closing: Promise<void>[] = [];
			for (const [key, entry] of this.#entries) closing.push(this.#closeEntry(key, entry));
			const results = await Promise.allSettled(closing);
			// Closing live clients also cancels initialize requests. Waiting for initialization
			// first would leave a revoked server running until its ordinary request timeout.
			await Promise.allSettled(this.#initializing.values());
			for (const result of results) if (result.status === "rejected") throw result.reason;
			this.#workspaceClaims.clear();
			this.#failures.clear();
		} finally { this.#shutdownOperation = undefined; }
	}

	#closeEntry(key: string, entry: PoolEntry): Promise<void> {
		if (entry.idleTimer) clearTimeout(entry.idleTimer);
		entry.idleTimer = undefined;
		return entry.closing ??= Promise.resolve().then(async () => {
			try {
				await entry.client.shutdown();
				this.#removeEntry(key, entry);
			} catch (error) {
				// Retain the exact failed client and close all admission until explicit recovery.
				this.#shuttingDown = true;
				throw error;
			} finally { entry.closing = undefined; }
		});
	}

	async #createClient(
		adapter: LspServerAdapter,
		root: string,
		timeoutMs: number,
		identity: PoolIdentity,
		superseded?: { key: string; entry: PoolEntry },
	) {
		const { key, rootKey } = identity;
		let client: LspClient | undefined;
		try {
			if (superseded) {
				await this.#closeEntry(superseded.key, superseded.entry);
			}

			const stale = this.#entries.get(key);
			if (stale) {
				await this.#closeEntry(key, stale);
			}
			if (this.#shuttingDown) throw new Error("The LSP client pool is shutting down.");
			this.#workspaceClaims.set(rootKey, key);

			client = new LspClient(adapter, adapter.defaultCommand, root, timeoutMs);
			this.#entries.set(key, { client, rootKey, leases: 0 });
			await client.start();
			await client.initialize(root);
			if (this.#shuttingDown || this.#workspaceClaims.get(rootKey) !== key) {
				throw new Error("LSP initialization was cancelled before the client could be pooled.");
			}
			return client;
		} catch (error) {
			const entry = this.#entries.get(key);
			if (entry && entry.client === client) await this.#closeEntry(key, entry);
			const message = error instanceof Error ? error.message : String(error);
			if (!this.#shuttingDown) this.#recordFailure(key, message);
			if (this.#workspaceClaims.get(rootKey) === key) this.#workspaceClaims.delete(rootKey);
			throw error;
		} finally {
			this.#initializing.delete(key);
		}
	}

	#recordFailure(key: string, message: string) {
		this.#failures.delete(key);
		while (this.#failures.size >= MAX_FAILURE_BACKOFFS) {
			const oldestKey = this.#failures.keys().next().value;
			if (oldestKey === undefined) break;
			this.#failures.delete(oldestKey);
		}
		this.#failures.set(key, { until: Date.now() + FAILURE_BACKOFF_MS, message });
	}

	#checkoutInitialized(key: string, client: LspClient, reused: boolean) {
		const entry = this.#entries.get(key);
		if (!entry || entry.client !== client || entry.closing || !client.running || this.#shuttingDown) {
			throw new Error("The initialized LSP client is no longer available.");
		}
		return this.#checkout(key, entry, reused);
	}

	#checkout(key: string, entry: PoolEntry, reused: boolean): ClientLease {
		if (entry.idleTimer) {
			clearTimeout(entry.idleTimer);
			entry.idleTimer = undefined;
		}
		entry.leases += 1;
		return { key, client: entry.client, reused };
	}

	#scheduleIdle(key: string, entry: PoolEntry) {
		if (entry.idleTimer) clearTimeout(entry.idleTimer);
		entry.idleTimer = undefined;
		if (this.#idleMs <= 0 || this.#shuttingDown || entry.closing) return;
		entry.idleTimer = setTimeout(() => {
			entry.idleTimer = undefined;
			if (this.#entries.get(key) !== entry || entry.leases > 0) return;
			void this.#closeEntry(key, entry).catch(observeIdleShutdown);
		}, this.#idleMs);
		entry.idleTimer.unref?.();
	}

	#removeEntry(key: string, entry: PoolEntry) {
		if (entry.idleTimer) clearTimeout(entry.idleTimer);
		entry.idleTimer = undefined;
		if (this.#entries.get(key) === entry) this.#entries.delete(key);
		if (this.#workspaceClaims.get(entry.rootKey) === key) {
			this.#workspaceClaims.delete(entry.rootKey);
		}
	}
}

// The pool retains the failed entry and closes admission; shutdownAll reports/retries it.
function observeIdleShutdown(): void {}

function poolIdentity(adapter: LspServerAdapter, root: string): PoolIdentity {
	const command = adapter.defaultCommand;
	const rootKey = realpathSync(root);
	return {
		rootKey,
		key: JSON.stringify([
			adapter.name,
			command.command,
			command.args,
			adapter.env ?? null,
			adapter.initialization ?? null,
			rootKey,
		]),
	};
}

function serverNameFromKey(key: string): string {
	const parsed: unknown = JSON.parse(key);
	return Array.isArray(parsed) && typeof parsed[0] === "string" ? parsed[0] : "another server";
}
