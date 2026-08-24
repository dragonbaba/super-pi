import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { Value } from "typebox/value";
import type { Tool, ToolCall } from "../types.ts";

const validatorCache = new WeakMap<object, ReturnType<typeof Compile>>();
const TYPEBOX_KIND = Symbol.for("TypeBox.Kind");
const TOOL_INPUT_REPAIRS = Symbol.for("pi.toolInputRepairs");
const MAX_TOOL_INPUT_REPAIR_PASSES = 4;
const MAX_JSON_ARRAY_REPAIR_CHARS = 1_000_000;
const DEGENERATE_MARKDOWN_PATH_LINK = /^(?:(.*[\\/]))?\[([^\]\r\n\\/]+)\]\((https?:\/\/[^)\r\n]+)\)$/i;
const BUILTIN_PATH_DESCRIPTIONS = new Set([
	"Path to the file to read (relative or absolute)",
	"Path to the file to write (relative or absolute)",
	"Path to the file to edit (relative or absolute)",
	"Directory or file to search (default: current directory)",
	"Directory to search in (default: current directory)",
	"Directory to list (default: current directory)",
]);

interface JsonSchemaObject {
	type?: string | string[];
	properties?: Record<string, JsonSchemaObject>;
	required?: string[];
	description?: string;
	items?: JsonSchemaObject | JsonSchemaObject[];
	additionalProperties?: boolean | JsonSchemaObject;
	allOf?: JsonSchemaObject[];
	anyOf?: JsonSchemaObject[];
	oneOf?: JsonSchemaObject[];
}

function dottedValidationPath(instancePath: string): string {
	const withoutLeadingSlash = instancePath.startsWith("/") ? instancePath.slice(1) : instancePath;
	return withoutLeadingSlash.replaceAll("/", ".");
}

function getSchemaTypes(schema: JsonSchemaObject): string[] {
	if (typeof schema.type === "string") {
		return [schema.type];
	}
	if (Array.isArray(schema.type)) {
		return schema.type.filter((type): type is string => typeof type === "string");
	}
	return [];
}

function matchesJsonType(value: unknown, type: string): boolean {
	switch (type) {
		case "number":
			return typeof value === "number";
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "string":
			return typeof value === "string";
		case "null":
			return value === null;
		case "array":
			return Array.isArray(value);
		case "object":
			return typeof value === "object" && value !== null && !Array.isArray(value);
		default:
			return false;
	}
}

function getSubSchemaValidator(schema: JsonSchemaObject): ReturnType<typeof Compile> | undefined {
	try {
		return getValidator(schema as Tool["parameters"]);
	} catch {
		return undefined;
	}
}

function coercePrimitiveByType(value: unknown, type: string): unknown {
	switch (type) {
		case "number": {
			if (value === null) {
				return 0;
			}
			if (typeof value === "string" && value.trim() !== "") {
				const parsed = Number(value);
				if (Number.isFinite(parsed)) {
					return parsed;
				}
			}
			if (typeof value === "boolean") {
				return value ? 1 : 0;
			}
			return value;
		}
		case "integer": {
			if (value === null) {
				return 0;
			}
			if (typeof value === "string" && value.trim() !== "") {
				const parsed = Number(value);
				if (Number.isInteger(parsed)) {
					return parsed;
				}
			}
			if (typeof value === "boolean") {
				return value ? 1 : 0;
			}
			return value;
		}
		case "boolean": {
			if (value === null) {
				return false;
			}
			if (typeof value === "string") {
				if (value === "true") {
					return true;
				}
				if (value === "false") {
					return false;
				}
			}
			if (typeof value === "number") {
				if (value === 1) {
					return true;
				}
				if (value === 0) {
					return false;
				}
			}
			return value;
		}
		case "string": {
			if (value === null) {
				return "";
			}
			if (typeof value === "number" || typeof value === "boolean") {
				return String(value);
			}
			return value;
		}
		case "null": {
			if (value === "" || value === 0 || value === false) {
				return null;
			}
			return value;
		}
		default:
			return value;
	}
}

function applySchemaObjectCoercion(value: Record<string, unknown>, schema: JsonSchemaObject): void {
	const properties = schema.properties;
	const definedKeys = new Set<string>(properties ? Object.keys(properties) : []);

	if (properties) {
		for (const [key, propertySchema] of Object.entries(properties)) {
			if (!(key in value)) {
				continue;
			}
			value[key] = coerceWithJsonSchema(value[key], propertySchema);
		}
	}

	if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
		for (const [key, propertyValue] of Object.entries(value)) {
			if (definedKeys.has(key)) {
				continue;
			}
			value[key] = coerceWithJsonSchema(propertyValue, schema.additionalProperties);
		}
	}
}

function applySchemaArrayCoercion(value: unknown[], schema: JsonSchemaObject): void {
	if (Array.isArray(schema.items)) {
		for (let index = 0; index < value.length; index++) {
			const itemSchema = schema.items[index];
			if (!itemSchema) {
				continue;
			}
			value[index] = coerceWithJsonSchema(value[index], itemSchema);
		}
		return;
	}

	if (schema.items && typeof schema.items === "object") {
		for (let index = 0; index < value.length; index++) {
			value[index] = coerceWithJsonSchema(value[index], schema.items);
		}
	}
}

function coerceWithUnionSchema(value: unknown, schemas: JsonSchemaObject[]): unknown {
	for (const schema of schemas) {
		const validator = getSubSchemaValidator(schema);
		if (validator?.Check(value)) {
			return value;
		}
	}

	for (const schema of schemas) {
		const candidate = structuredClone(value);
		const coerced = coerceWithJsonSchema(candidate, schema);
		const validator = getSubSchemaValidator(schema);
		if (validator?.Check(coerced)) {
			return coerced;
		}
	}
	return value;
}

function coerceWithJsonSchema(value: unknown, schema: JsonSchemaObject): unknown {
	let nextValue = value;

	if (Array.isArray(schema.allOf)) {
		for (const nested of schema.allOf) {
			nextValue = coerceWithJsonSchema(nextValue, nested);
		}
	}

	if (Array.isArray(schema.anyOf)) {
		nextValue = coerceWithUnionSchema(nextValue, schema.anyOf);
	}

	if (Array.isArray(schema.oneOf)) {
		nextValue = coerceWithUnionSchema(nextValue, schema.oneOf);
	}

	const schemaTypes = getSchemaTypes(schema);
	const matchesUnionMember =
		schemaTypes.length > 1 && schemaTypes.some((schemaType) => matchesJsonType(nextValue, schemaType));
	if (schemaTypes.length > 0 && !matchesUnionMember) {
		for (const schemaType of schemaTypes) {
			const candidate = coercePrimitiveByType(nextValue, schemaType);
			if (candidate !== nextValue) {
				nextValue = candidate;
				break;
			}
		}
	}

	if (
		schemaTypes.includes("object") &&
		typeof nextValue === "object" &&
		nextValue !== null &&
		!Array.isArray(nextValue)
	) {
		applySchemaObjectCoercion(nextValue as Record<string, unknown>, schema);
	}

	if (schemaTypes.includes("array") && Array.isArray(nextValue)) {
		applySchemaArrayCoercion(nextValue, schema);
	}

	return nextValue;
}

function getValidator(schema: Tool["parameters"]): ReturnType<typeof Compile> {
	const key = schema as object;
	const cached = validatorCache.get(key);
	if (cached) {
		return cached;
	}
	const validator = Compile(schema);
	validatorCache.set(key, validator);
	return validator;
}

function formatValidationPath(error: TLocalizedValidationError): string {
	if (error.keyword === "required") {
		const requiredProperties = (error.params as { requiredProperties?: string[] }).requiredProperties;
		const requiredProperty = requiredProperties?.[0];
		if (requiredProperty) {
			const basePath = dottedValidationPath(error.instancePath);
			return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
		}
	}
	const path = dottedValidationPath(error.instancePath);
	return path || "root";
}

/**
 * Finds a tool by name and validates the tool call arguments against its TypeBox schema
 * @param tools Array of tool definitions
 * @param toolCall The tool call from the LLM
 * @returns The validated arguments
 * @throws Error if tool is not found or validation fails
 */
export function validateToolCall(tools: Tool[], toolCall: ToolCall): any {
	const tool = tools.find((t) => t.name === toolCall.name);
	if (!tool) {
		throw new Error(`Tool "${toolCall.name}" not found`);
	}
	return validateToolArguments(tool, toolCall);
}

function decodeJsonPointer(instancePath: string): string[] {
	if (!instancePath) return [];
	return instancePath
		.slice(1)
		.split("/")
		.map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function schemaAtPath(schema: JsonSchemaObject, path: string[]): JsonSchemaObject | undefined {
	let current: JsonSchemaObject | undefined = schema;
	for (const part of path) {
		if (!current || typeof current !== "object") return undefined;
		if (current.properties && typeof current.properties === "object" && part in current.properties) {
			current = current.properties[part];
			continue;
		}
		if (Array.isArray(current.items)) {
			const index = Number(part);
			if (!Number.isInteger(index) || !current.items[index]) return undefined;
			current = current.items[index];
			continue;
		}
		if (current.items && typeof current.items === "object") {
			current = current.items;
			continue;
		}
		return undefined;
	}
	return current;
}

function valueAtPath(root: unknown, path: string[]): { found: boolean; value?: unknown } {
	let value = root;
	for (const part of path) {
		if (value === null || typeof value !== "object" || !(part in value)) return { found: false };
		value = (value as Record<string, unknown>)[part];
	}
	return { found: true, value };
}

function setValueAtPath(root: unknown, path: string[], value: unknown): unknown {
	if (path.length === 0) return value;
	const parentLocation = valueAtPath(root, path.slice(0, -1));
	if (!parentLocation.found || parentLocation.value === null || typeof parentLocation.value !== "object") return root;
	(parentLocation.value as Record<string, unknown>)[path[path.length - 1]] = value;
	return root;
}

function deleteOptionalNull(root: unknown, schema: JsonSchemaObject, path: string[]): boolean {
	if (path.length === 0) return false;
	const location = valueAtPath(root, path);
	if (!location.found || location.value !== null) return false;
	const parentPath = path.slice(0, -1);
	const parentSchema = schemaAtPath(schema, parentPath);
	const key = path[path.length - 1];
	if (!parentSchema?.properties || !(key in parentSchema.properties) || parentSchema.required?.includes(key)) {
		return false;
	}
	const parentLocation = valueAtPath(root, parentPath);
	if (!parentLocation.found || parentLocation.value === null || typeof parentLocation.value !== "object") return false;
	delete (parentLocation.value as Record<string, unknown>)[key];
	return true;
}

type RepairResult =
	| { changed: false }
	| {
			changed: true;
			value: unknown;
			kind: "primitive_coerced" | "json_array_parsed" | "bare_value_wrapped" | "empty_placeholder_to_array";
	  };

function convertedPrimitive(value: unknown, schema: JsonSchemaObject): RepairResult {
	if (value === null) return { changed: false };
	const types = getSchemaTypes(schema);
	if (types.includes("array") || types.includes("object")) return { changed: false };
	let candidate = Value.Convert(schema as Tool["parameters"], structuredClone(value));
	if (!Object.getOwnPropertySymbols(schema).includes(TYPEBOX_KIND)) {
		candidate = coerceWithJsonSchema(candidate, schema);
	}
	let valid = false;
	try {
		valid = getValidator(schema as Tool["parameters"]).Check(candidate);
	} catch {
		return { changed: false };
	}
	return valid && !Object.is(candidate, value)
		? { changed: true, value: candidate, kind: "primitive_coerced" }
		: { changed: false };
}

function repairArrayValue(value: unknown, schema: JsonSchemaObject): RepairResult {
	let validator: ReturnType<typeof Compile>;
	try {
		validator = getValidator(schema as Tool["parameters"]);
	} catch {
		return { changed: false };
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
			if (trimmed.length > MAX_JSON_ARRAY_REPAIR_CHARS) return { changed: false };
			try {
				const parsed: unknown = JSON.parse(trimmed);
				if (Array.isArray(parsed) && validator.Check(parsed)) {
					return { changed: true, value: parsed, kind: "json_array_parsed" };
				}
			} catch {}
			return { changed: false };
		}
		const wrapped = [value];
		if (validator.Check(wrapped)) return { changed: true, value: wrapped, kind: "bare_value_wrapped" };
	}
	if (
		value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).length === 0 &&
		validator.Check([])
	) {
		return { changed: true, value: [], kind: "empty_placeholder_to_array" };
	}
	return { changed: false };
}

function repairIssue(root: unknown, schema: JsonSchemaObject, error: TLocalizedValidationError): string | undefined {
	const path = decodeJsonPointer(error.instancePath);
	if (deleteOptionalNull(root, schema, path)) return "optional_null_omitted";
	const location = valueAtPath(root, path);
	const targetSchema = schemaAtPath(schema, path);
	if (!location.found || !targetSchema) return undefined;
	let repair: RepairResult = { changed: false };
	if (getSchemaTypes(targetSchema).includes("array")) repair = repairArrayValue(location.value, targetSchema);
	if (!repair.changed) repair = convertedPrimitive(location.value, targetSchema);
	if (!repair.changed) return undefined;
	setValueAtPath(root, path, repair.value);
	return repair.kind;
}

function unwrapDegenerateMarkdownPath(value: string): string {
	if (!value.includes("](") || !value.includes("[")) return value;
	const match = DEGENERATE_MARKDOWN_PATH_LINK.exec(value);
	if (!match) return value;
	const prefix = match[1] ?? "";
	const label = match[2];
	const url = match[3];
	const protocolEnd = url.indexOf("://");
	let urlWithoutProtocol = protocolEnd >= 0 ? url.slice(protocolEnd + 3) : url;
	if (urlWithoutProtocol.endsWith("/")) urlWithoutProtocol = urlWithoutProtocol.slice(0, -1);
	return label === urlWithoutProtocol ? prefix + label : value;
}

function repairBuiltInPath(tool: Tool, args: unknown, repairs: string[]): void {
	if (!args || typeof args !== "object" || typeof (args as Record<string, unknown>).path !== "string") return;
	const pathSchema = (tool.parameters as JsonSchemaObject).properties?.path;
	if (!pathSchema || !BUILTIN_PATH_DESCRIPTIONS.has(pathSchema.description ?? "")) return;
	const argumentObject = args as Record<string, unknown>;
	const repairedPath = unwrapDegenerateMarkdownPath(argumentObject.path as string);
	if (repairedPath !== argumentObject.path) {
		argumentObject.path = repairedPath;
		repairs.push("markdown_path_unwrapped");
	}
}

function validRepairResult(tool: Tool, args: unknown, repairs: string[]): { valid: true; args: unknown } {
	repairBuiltInPath(tool, args, repairs);
	if (repairs.length > 0 && args && typeof args === "object") {
		Object.defineProperty(args, TOOL_INPUT_REPAIRS, {
			value: Object.freeze([...new Set(repairs)]),
			enumerable: false,
		});
	}
	return { valid: true, args };
}

function validateAndRepairToolArguments(
	tool: Tool,
	originalArgs: unknown,
	validator: ReturnType<typeof Compile>,
): { valid: boolean; args: unknown } {
	const args = structuredClone(originalArgs);
	const repairs: string[] = [];
	if (validator.Check(args)) return validRepairResult(tool, args, repairs);
	for (let pass = 0; pass < MAX_TOOL_INPUT_REPAIR_PASSES; pass++) {
		const errors = [...validator.Errors(args)];
		let changed = false;
		for (const error of errors) {
			const kind = repairIssue(args, tool.parameters as JsonSchemaObject, error);
			if (kind) {
				repairs.push(kind);
				changed = true;
			}
		}
		if (validator.Check(args)) return validRepairResult(tool, args, repairs);
		if (!changed) break;
	}
	return { valid: false, args };
}

/**
 * Validates tool call arguments against the tool's TypeBox schema
 * @param tool The tool definition with TypeBox schema
 * @param toolCall The tool call from the LLM
 * @returns The validated (and potentially coerced) arguments
 * @throws Error with formatted message if validation fails
 */
export function validateToolArguments(tool: Tool, toolCall: ToolCall): any {
	const validator = getValidator(tool.parameters);
	const validation = validateAndRepairToolArguments(tool, toolCall.arguments, validator);
	const args = validation.args;
	if (validation.valid) return args;

	const errors =
		validator
			.Errors(args)
			.map((error) => `  - ${formatValidationPath(error)}: ${error.message}`)
			.join("\n") || "Unknown validation error";

	const errorMessage = `Validation failed for tool "${toolCall.name}":\n${errors}\nRetry: Correct only the listed fields; received arguments are omitted.`;

	throw new Error(errorMessage);
}
