import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fchmodSync,
	fsyncSync,
	linkSync,
	mkdirSync,
	openSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export interface AtomicTextWriteOptions {
	mode?: number;
	preserveExistingMode?: boolean;
	enforceMode?: boolean;
	replaceExisting?: boolean;
}

const DEFAULT_ATOMIC_TEXT_WRITE_OPTIONS: AtomicTextWriteOptions = {};

function syncDirectory(directory: string): void {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(directory, "r");
		fsyncSync(descriptor);
	} catch {
		// Windows commonly rejects directory fsync; the file itself is durable.
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function existingFileMode(path: string): number | undefined {
	try {
		return statSync(path).mode & 0o777;
	} catch {
		return undefined;
	}
}

export function writeTextFileAtomically(
	path: string,
	contents: string,
	options: AtomicTextWriteOptions = DEFAULT_ATOMIC_TEXT_WRITE_OPTIONS,
): boolean {
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true });
	const requestedMode = options.mode ?? 0o600;
	const mode = options.preserveExistingMode ? (existingFileMode(path) ?? requestedMode) : requestedMode;
	const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	let descriptor: number | undefined;
	let installed = false;
	try {
		descriptor = openSync(temporaryPath, "wx", mode);
		writeFileSync(descriptor, contents, "utf8");
		if (options.enforceMode && process.platform !== "win32") fchmodSync(descriptor, requestedMode);
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		if (options.replaceExisting === false) {
			try {
				linkSync(temporaryPath, path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
				throw error;
			}
			unlinkSync(temporaryPath);
		} else {
			renameSync(temporaryPath, path);
		}
		installed = true;
		syncDirectory(directory);
		return true;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
		if (!installed && existsSync(temporaryPath)) unlinkSync(temporaryPath);
	}
}
