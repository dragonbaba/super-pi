const TRUNCATED = "[truncated: earlier stderr omitted]\n";
const MARKER_BYTES = TRUNCATED.length;

export function capStderrTail(value: string, maxBytes: number): string {
    if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
    if (maxBytes <= MARKER_BYTES) return TRUNCATED.slice(0, Math.max(0, maxBytes));
    const budget = maxBytes - MARKER_BYTES;
    let low = Math.max(0, value.length - budget), high = value.length;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (Buffer.byteLength(value.slice(middle), "utf8") <= budget) high = middle;
        else low = middle + 1;
    }
    if (low > 0 && value.charCodeAt(low) >= 0xDC00 && value.charCodeAt(low) <= 0xDFFF
        && value.charCodeAt(low - 1) >= 0xD800 && value.charCodeAt(low - 1) <= 0xDBFF) low++;
    return TRUNCATED + value.slice(low);
}

/** Fixed per-child byte storage; decoding happens once after the stderr stream closes. */
export class StderrTail {
    private readonly capacity: number;
    private buffer: Buffer | undefined;
    private position = 0;
    private size = 0;
    private truncated = false;
    constructor(capacity: number) { this.capacity = capacity; this.buffer = Buffer.allocUnsafe(capacity); }

    push(chunk: Buffer): void {
        const buffer = this.buffer;
        if (!buffer) return;
        this.truncated ||= this.size + chunk.length > this.capacity;
        if (chunk.length >= this.capacity) {
            chunk.copy(buffer, 0, chunk.length - this.capacity);
            this.size = this.capacity; this.position = 0; return;
        }
        const first = Math.min(chunk.length, this.capacity - this.position);
        chunk.copy(buffer, this.position, 0, first);
        if (first < chunk.length) chunk.copy(buffer, 0, first);
        this.position = (this.position + chunk.length) % this.capacity;
        this.size = Math.min(this.capacity, this.size + chunk.length);
    }

    take(): string {
        const buffer = this.buffer;
        if (!buffer) return "";
        this.buffer = undefined;
        const bytes = Buffer.allocUnsafe(this.size);
        const start = (this.position - this.size + this.capacity) % this.capacity;
        const first = Math.min(this.size, this.capacity - start);
        buffer.copy(bytes, 0, start, start + first);
        if (first < this.size) buffer.copy(bytes, first, 0, this.size - first);
        let offset = 0;
        if (this.truncated) while (offset < bytes.length && (bytes[offset]! & 0xC0) === 0x80) offset++;
        const text = (this.truncated ? TRUNCATED : "") + bytes.toString("utf8", offset);
        this.position = 0; this.size = 0;
        return capStderrTail(text, this.capacity);
    }
}
