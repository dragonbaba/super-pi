import { randomUUID } from 'node:crypto';
import { openSync, fsyncSync, closeSync, existsSync, statSync, writeFileSync, renameSync, linkSync, unlinkSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';

function syncSessionDirectory(directory: string): void {
	let fd: number | undefined;
	try {
		fd = openSync(directory, "r");
		fsyncSync(fd);
	} catch {
		// Windows commonly refuses directory fsync; the file itself is already durable.
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

export function writeSessionEntriesAtomically(sessionFile: string, entries: readonly unknown[], replace: boolean, preserveFailure = false): void {
	const directory = dirname(sessionFile);
	const tempFile = join(directory, `.${basename(sessionFile)}.${process.pid}.${randomUUID()}.tmp`);
	const mode = replace && existsSync(sessionFile) ? statSync(sessionFile).mode & 0o777 : 0o600;
	let fd: number | undefined;
	let installed = false;
	try {
		fd = openSync(tempFile, "wx", mode);
		for (const entry of entries) writeFileSync(fd, `${JSON.stringify(entry)}\n`);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		if (replace) renameSync(tempFile, sessionFile);
		else {
			linkSync(tempFile, sessionFile);
			unlinkSync(tempFile);
		}
		installed = true;
		syncSessionDirectory(directory);
	} finally {
		if (fd !== undefined) closeSync(fd);
		if (!installed && !preserveFailure && existsSync(tempFile)) unlinkSync(tempFile);
	}
}

