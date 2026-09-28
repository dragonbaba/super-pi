/** Host-only generation used to reject asynchronous render work from a released tool owner. */
export const TOOL_RENDER_LIFECYCLE_GENERATION = Symbol("tool-render-lifecycle-generation");

/** Cache-only release hook shared with bundled renderers loaded in separate module scopes. */
export const RELEASE_TOOL_RENDER_DERIVED_STATE = Symbol.for("pi.tool-render.release-derived-state.v1");

export type ToolRenderLifecycleState = {
	[TOOL_RENDER_LIFECYCLE_GENERATION]?: number;
	[RELEASE_TOOL_RENDER_DERIVED_STATE]?: (state: unknown) => void;
};
