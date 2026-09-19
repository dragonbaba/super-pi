export const ANTHROPIC_MODEL_VERSION_PATTERN = /^claude-(?:opus|sonnet|fable)-(\d+)(?:-(\d+))?(?:-|$)/u;
export const TOOL_CALL_ID_SANITIZE_PATTERN = /[^a-zA-Z0-9_-]/gu;