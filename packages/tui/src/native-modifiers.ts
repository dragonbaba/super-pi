import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const cjsRequire = createRequire(import.meta.url);

export type ModifierKey = "shift" | "command" | "control" | "option";

type NativeModifiersHelper = {
	isModifierPressed: (name: ModifierKey) => boolean;
	enableVirtualTerminalInput?: () => boolean;
};

let nativeModifiersHelper: NativeModifiersHelper | null | undefined;

function isNativeModifiersHelper(value: unknown): value is NativeModifiersHelper {
	if (typeof value !== "object" || value === null) return false;
	const candidate = (value as { isModifierPressed?: unknown }).isModifierPressed;
	return typeof candidate === "function";
}

function tryLoadNativeModifiersHelper(modulePath: string): NativeModifiersHelper | undefined {
	try {
		const helper = cjsRequire(modulePath) as unknown;
		return isNativeModifiersHelper(helper) ? helper : undefined;
	} catch {
		return undefined;
	}
}

function loadNativeModifiersHelper(): NativeModifiersHelper | undefined {
	if (nativeModifiersHelper !== undefined) return nativeModifiersHelper ?? undefined;
	nativeModifiersHelper = null;
	const arch = process.arch;
	if (arch !== "x64" && arch !== "arm64") return undefined;

	let nativePath: string;
	if (process.platform === "darwin") {
		nativePath = path.join("native", "darwin", "prebuilds", `darwin-${arch}`, "darwin-modifiers.node");
	} else if (process.platform === "win32") {
		nativePath = path.join("native", "win32", "prebuilds", `win32-${arch}`, "win32-console-mode.node");
	} else {
		return undefined;
	}

	const moduleDir = path.dirname(fileURLToPath(import.meta.url));
	const packageHelper = tryLoadNativeModifiersHelper(path.join(moduleDir, "..", nativePath));
	if (packageHelper) {
		nativeModifiersHelper = packageHelper;
		return packageHelper;
	}
	const sourceHelper = tryLoadNativeModifiersHelper(path.join(moduleDir, nativePath));
	if (sourceHelper) {
		nativeModifiersHelper = sourceHelper;
		return sourceHelper;
	}
	const executableHelper = tryLoadNativeModifiersHelper(path.join(path.dirname(process.execPath), nativePath));
	if (executableHelper) {
		nativeModifiersHelper = executableHelper;
		return executableHelper;
	}

	return undefined;
}

/** Re-apply Windows VT input after raw-mode setup resets console flags. */
export function enableNativeWindowsVirtualTerminalInput(): void {
	if (process.platform !== "win32") return;
	const helper = loadNativeModifiersHelper();
	if (!helper?.enableVirtualTerminalInput) return;
	try {
		helper.enableVirtualTerminalInput();
	} catch {
		// Native input enhancement is optional; ordinary terminal input remains usable.
	}
}

export function isNativeModifierPressed(key: ModifierKey): boolean {
	const helper = loadNativeModifiersHelper();
	if (!helper) return false;
	try {
		return helper.isModifierPressed(key) === true;
	} catch {
		return false;
	}
}
