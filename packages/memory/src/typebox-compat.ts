import type { TUnsafe } from "typebox";
import { Type } from "./schema.js";

/**
 * Local equivalent of Pi AI's StringEnum helper.
 * Keeping this tiny schema helper local avoids loading a second package-local
 * Pi AI runtime solely to create JSON Schema string enums.
 */
export function StringEnum<T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
  return Type.Unsafe({
    type: "string",
    enum: values,
    ...(options?.description ? { description: options.description } : {}),
    ...(options?.default ? { default: options.default } : {}),
  });
}
