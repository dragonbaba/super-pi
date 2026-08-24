import { realpathSync } from "node:fs";
import { LspClient } from "./lsp-client.js";
import type { LspServerAdapter } from "./types.js";

const DEFAULT_IDLE_MS = 10 * 60_000;
const FAILURE_BACKOFF_MS = 3 * 60_000;
const MAX_FAILURE_BACKOFFS = 64;

interface PoolEntry {
	client: LspClient;
	rootKey: string;
	leases: number;
	idleTimer?: NodeJS.Timeout;
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

	constructor(idleMs = DEFAULT_IDLE_MS) {
		this.#idleMs = idleMs;
	}

	reopen() {
		if (!this.#shuttingDown) return;
		if (this.#initializing.size > 0 || this.#entries.size > 0) {
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
		const existing = this.#entries.get(key);
		if (existing?.client.running) return this.#checkout(key, existing, true);

		const pending = this.#initializing.get(key);
		if (pending) {
			const client = await pending;
			return this.#checkoutInitialized(key, client, true);
		}

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
		if (entry?.client === lease.client) this.#removeEntry(lease.key, entry);
		await lease.client.shutdown();
	}

	async shutdownAll() {
		this.#shuttingDown = true;
		for (const entry of this.#entries.values()) {
			if (entry.idleTimer) clearTimeout(entry.idleTimer);
		}

		const pending = [...this.#initializing.values()];
		await Promise.allSettled(pending);
		const clients = [...new Set([...this.#entries.values()].map((entry) => entry.client))];
		this.#entries.clear();
		this.#initializing.clear();
		this.#workspaceClaims.clear();
		this.#failures.clear();
		await Promise.allSettled(clients.map((client) => client.shutdown()));
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
				this.#removeEntry(superseded.key, superseded.entry, false);
				await superseded.entry.client.shutdown();
			}

			const stale = this.#entries.get(key);
			if (stale) {
				this.#removeEntry(key, stale, false);
				await stale.client.shutdown();
			}
			if (this.#shuttingDown) throw new Error("The LSP client pool is shutting down.");

			client = new LspClient(adapter, adapter.defaultCommand, root, timeoutMs);
			await client.start();
			await client.initialize(root);
			if (this.#shuttingDown || this.#workspaceClaims.get(rootKey) !== key) {
				throw new Error("LSP initialization was cancelled before the client could be pooled.");
			}
			this.#entries.set(key, { client, rootKey, leases: 0 });
			return client;
		} catch (error) {
			if (client) await client.shutdown();
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
		if (!entry || entry.client !== client || !client.running || this.#shuttingDown) {
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
		if (this.#idleMs <= 0) return;
		entry.idleTimer = setTimeout(() => {
			if (this.#entries.get(key) !== entry || entry.leases > 0) return;
			this.#removeEntry(key, entry);
			void entry.client.shutdown();
		}, this.#idleMs);
		entry.idleTimer.unref?.();
	}

	#removeEntry(key: string, entry: PoolEntry, releaseClaim = true) {
		if (entry.idleTimer) clearTimeout(entry.idleTimer);
		this.#entries.delete(key);
		if (releaseClaim && this.#workspaceClaims.get(entry.rootKey) === key) {
			this.#workspaceClaims.delete(entry.rootKey);
		}
	}
}

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
