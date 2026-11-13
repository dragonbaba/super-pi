// Keep the component out of extension startup, including the bundled runtime.
export type { BoundedSelectorItem } from "./bounded-selector.ts";
export function loadBoundedSelector() { return import("./bounded-selector.ts"); }
