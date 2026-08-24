import type { TSchema } from "typebox";

type SchemaOptions = Record<string, unknown>;
type LocalSchema = TSchema & {
  readonly "~kind"?: string;
  readonly "~optional"?: boolean;
};

function tagged(kind: string, value: SchemaOptions): LocalSchema {
  Object.defineProperty(value, "~kind", {
    configurable: true,
    enumerable: false,
    value: kind,
    writable: true,
  });
  return value as LocalSchema;
}

function scalar(kind: string, type: string, options: SchemaOptions = {}): LocalSchema {
  return tagged(kind, { type, ...options });
}

/**
 * Minimal TypeBox-compatible builders for the schemas this extension exposes.
 * Pi only needs the JSON Schema fields and TypeBox's non-enumerable runtime
 * markers; avoiding a second package-local TypeBox runtime saves ~80 ms during
 * process startup while keeping validation semantics identical.
 */
export const Type = {
  String(options: SchemaOptions = {}): any {
    return scalar("String", "string", options);
  },
  Number(options: SchemaOptions = {}): any {
    return scalar("Number", "number", options);
  },
  Integer(options: SchemaOptions = {}): any {
    return scalar("Integer", "integer", options);
  },
  Array(items: LocalSchema, options: SchemaOptions = {}): any {
    return tagged("Array", { type: "array", items, ...options });
  },
  Object(properties: Record<string, LocalSchema>, options: SchemaOptions = {}): any {
    const required: string[] = [];
    for (const name in properties) {
      if (properties[name]["~optional"] !== true) required.push(name);
    }
    return tagged("Object", {
      type: "object",
      ...(required.length > 0 ? { required } : {}),
      properties,
      ...options,
    });
  },
  Optional(schema: LocalSchema): any {
    const optional = tagged(schema["~kind"] ?? "Unknown", { ...schema });
    Object.defineProperty(optional, "~optional", {
      configurable: true,
      enumerable: false,
      value: true,
      writable: true,
    });
    return optional;
  },
  Unsafe(schema: SchemaOptions): any {
    const unsafe = { ...schema } as LocalSchema;
    Object.defineProperty(unsafe, "~unsafe", {
      configurable: true,
      enumerable: false,
      value: true,
      writable: true,
    });
    return unsafe;
  },
} as const;
