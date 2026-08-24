export const DIMENSION_RE = /^[A-Za-z0-9._/@:+-]{1,120}$/u;
export const DIMENSION_UNSAFE_RE = /[^A-Za-z0-9._/@:+-]+/gu;
export const DIMENSION_EDGE_UNDERSCORES_RE = /^_+|_+$/gu;
export const EVENT_HASH_RE = /^[a-f0-9]{24}$/u;
