/** Count the existing string without materializing a second encoded frame. */
export function utf8ByteLength(value: string): number {
	if (typeof Buffer !== "undefined") return Buffer.byteLength(value, "utf8");
	let bytes = 0;
	for (let index = 0; index < value.length; index++) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit <= 0x7f) bytes++;
		else if (codeUnit <= 0x7ff) bytes += 2;
		else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < value.length) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; index++; }
			else bytes += 3;
		} else bytes += 3;
	}
	return bytes;
}
