/** Host-only generation used to reject asynchronous render work from a released tool owner. */
export const TOOL_RENDER_LIFECYCLE_GENERATION = Symbol("tool-render-lifecycle-generation");

/** Built-in renderer hook for dropping derived state at a cache-only release boundary. */
export const RELEASE_TOOL_RENDER_DERIVED_STATE = Symbol("release-tool-render-derived-state");

export type ToolRenderLifecycleState = {
	[TOOL_RENDER_LIFECYCLE_GENERATION]?: number;
	[RELEASE_TOOL_RENDER_DERIVED_STATE]?: (state: unknown) => void;
};
