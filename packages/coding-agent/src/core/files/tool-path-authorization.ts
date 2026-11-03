// Cold invocation binding: execution uses the path the native policy actually checked.
const AUTHORIZED_PATH = Symbol.for("pi.native-permission.tool-path.v1");
const CONSUMED: PropertyDescriptor = Object.freeze({ configurable: true, enumerable: false, writable: false, value: undefined });
interface AuthorizedPath {
    tool: string; id: string; raw: unknown; canonical: string; assertCurrent(): void;
}
export function attachToolPath(input: object & { path?: unknown }, tool: string, id: string, canonical: string, assertCurrent: () => void): void {
    Object.defineProperty(input, AUTHORIZED_PATH, { configurable: true, enumerable: false, writable: false,
        value: Object.freeze({ tool, id, raw: input.path, canonical, assertCurrent }) });
}
export function consumeToolPath(input: object & { path?: unknown }, tool: string, id: string): string | undefined {
    const grant = (input as { [AUTHORIZED_PATH]?: AuthorizedPath })[AUTHORIZED_PATH];
    if (!grant) return undefined;
    Object.defineProperty(input, AUTHORIZED_PATH, CONSUMED);
    grant.assertCurrent();
    if (grant.tool !== tool || grant.id !== id || grant.raw !== input.path) throw new Error("[POLICY_BLOCKED] Authorized tool path changed");
    return grant.canonical;
}
