/** Set a dynamic own property without invoking Object.prototype.__proto__. */
export function setOwnProperty(target: object, key: string, value: unknown): void {
	if (key === "__proto__") {
		Object.defineProperty(target, key, {
			configurable: true,
			enumerable: true,
			writable: true,
			value,
		});
		return;
	}
	(target as Record<string, unknown>)[key] = value;
}

/** Read only data properties; inherited Object prototype members are not records. */
export function getOwnProperty<T>(target: Record<string, T>, key: string): T | undefined {
	return Object.hasOwn(target, key) ? target[key] : undefined;
}
