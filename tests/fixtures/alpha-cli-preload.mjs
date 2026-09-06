// Pipe-backed CLI smoke seam, explicitly not a native PTY or Windows Terminal claim.
Object.defineProperty(process.stdin, 'isTTY', { value: true });
Object.defineProperty(process.stdout, 'isTTY', { value: true });
process.stdout.columns = 120;
process.stdout.rows = 40;
process.stdin.isRaw = false;
process.stdin.setRawMode = function (raw) { this.isRaw = raw; return this; };
process.on('exit', code => process.stderr.write(`ALPHA_EXIT:${code}:RAW:${process.stdin.isRaw}\n`));
