// Stable fixture parsing only; production consumes its own dedicated modules.
export const FIXTURE_SNAPSHOT_ID_PATTERN = /snapshot=([A-Za-z0-9_-]+)/;
export const FIXTURE_SECOND_LINE_ANCHOR_PATTERN = /^2#[A-Fa-f0-9]+/m;
