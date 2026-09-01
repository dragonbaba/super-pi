/** Internal final-unmount hook for releasing render caches without semantic invalidation. */
export const RELEASE_COMPONENT_RENDER_CACHE = Symbol("release-component-render-cache");

/** Internal structural hook for traversing cache-owning composite components. */
export const GET_COMPONENT_RENDER_CACHE_CHILDREN = Symbol("get-component-render-cache-children");
