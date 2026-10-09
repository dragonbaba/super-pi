import type { Api, Model, ThinkingLevelMap } from "../types.ts";

// Test the original strings: catalog ingress and request preparation do not need
// candidate arrays, lowercase copies, or per-call regular expressions.
const HAIKU_55 = /(?:^|[^a-z0-9])haiku[-_.:\s]+5[-_.:\s]+5(?=$|[^a-z0-9])/i;

export const HAIKU_55_THINKING_LEVEL_MAP: Readonly<ThinkingLevelMap> = Object.freeze({
	off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max",
});

export function isHaiku55Model(model: Pick<Model<Api>, "id" | "name">): boolean {
	return HAIKU_55.test(model.id) || HAIKU_55.test(model.name);
}

/** Catalog defaults only; explicit caller/catalog overrides keep precedence. */
export function profileHaiku55Model<TApi extends Api>(model: Model<TApi>): Model<TApi> {
	if ((model.api !== "anthropic-messages" && model.api !== "bedrock-converse-stream") || !isHaiku55Model(model)) {
		return model;
	}
	return {
		...model,
		thinkingLevelMap: { ...HAIKU_55_THINKING_LEVEL_MAP, ...model.thinkingLevelMap },
		compat: (model.api === "anthropic-messages"
			? { forceAdaptiveThinking: true, supportsTemperature: false, ...model.compat }
			: { supportsTemperature: false, ...model.compat }) as Model<TApi>["compat"],
	};
}
