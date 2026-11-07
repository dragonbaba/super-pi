/**
 * Synchronous scope for render derivations that are valid only inside one
 * layout frame. `renderLayoutFrame()` opens the scope and releases every
 * registered owner when the outermost frame ends, including on throw.
 *
 * The registry holds owner references only while a frame is running; slots
 * are cleared to `undefined` on release, so no owner outlives its frame here.
 */
export interface LayoutFrameScopedOwner {
	releaseLayoutFrameScopedState(): void;
}

const owners: Array<LayoutFrameScopedOwner | undefined> = [];
let ownerCount = 0;
let depth = 0;

export function beginLayoutFrameScope(): void {
	depth++;
}

export function endLayoutFrameScope(): void {
	if (depth === 0) return;
	depth--;
	if (depth > 0) return;
	for (let index = 0; index < ownerCount; index++) {
		const owner = owners[index]!;
		owners[index] = undefined;
		owner.releaseLayoutFrameScopedState();
	}
	ownerCount = 0;
}

export function isLayoutFrameScopeActive(): boolean {
	return depth > 0;
}

/** Callers register at most once per frame; the owner tracks that with its own flag. */
export function registerLayoutFrameScopedOwner(owner: LayoutFrameScopedOwner): void {
	owners[ownerCount++] = owner;
}

/** Primitive diagnostics for lifecycle tests. */
export function getLayoutFrameScopeState(): { depth: number; registeredOwners: number; retainedOwnerSlots: number } {
	let retainedOwnerSlots = 0;
	for (let index = 0; index < owners.length; index++) if (owners[index] !== undefined) retainedOwnerSlots++;
	return { depth, registeredOwners: ownerCount, retainedOwnerSlots };
}
