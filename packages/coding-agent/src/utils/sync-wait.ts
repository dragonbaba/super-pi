const SYNC_WAIT_STATE = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

/** Block without consuming a CPU core. Use only at unavoidable synchronous API boundaries. */
export function waitSynchronously(milliseconds: number): void {
	if (milliseconds <= 0) return;
	Atomics.wait(SYNC_WAIT_STATE, 0, 0, milliseconds);
}
