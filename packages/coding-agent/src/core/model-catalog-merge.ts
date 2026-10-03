import type { Api, Model } from "@super-pi/ai";

/** Refresh-time merge. Preserve baseline order and first-ID replacement semantics. */
export function mergeCatalogModels(baseline: readonly Model<Api>[], dynamic: readonly Model<Api>[]): Model<Api>[] {
	const merged = baseline.slice();
	if (dynamic.length === 0) return merged;
	const positions = new Map<string, number>();
	for (let index = 0; index < baseline.length; index++) {
		const id = baseline[index]!.id;
		// A duplicate baseline ID historically replaced its first occurrence only.
		if (!positions.has(id)) positions.set(id, index);
	}
	for (let index = 0; index < dynamic.length; index++) {
		const model = dynamic[index]!;
		const id = model.id;
		const position = positions.get(id);
		if (position === undefined) {
			positions.set(id, merged.length);
			merged.push(model);
		} else merged[position] = model;
	}
	return merged;
}
