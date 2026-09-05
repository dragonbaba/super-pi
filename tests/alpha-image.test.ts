import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32, inflateSync } from 'node:zlib';
import { g2_raw_result_probe } from './fixtures/g2-raw-result-probe.ts';

test('raw image fixture is a complete CRC-valid, decodable one-pixel PNG', () => {
  const block = g2_raw_result_probe('image').content[1];
  assert.ok(block?.type === 'image');
  assert.equal(block.mimeType, 'image/png');
  const png = Buffer.from(block.data, 'base64');
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const chunks: string[] = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    assert.ok(offset + length + 12 <= png.length);
    const kind = png.toString('ascii', offset + 4, offset + 8);
    chunks.push(kind);
    const data = png.subarray(offset + 8, offset + 8 + length);
    assert.equal(crc32(png.subarray(offset + 4, offset + 8 + length)), png.readUInt32BE(offset + 8 + length), `${kind} CRC`);
    if (kind === 'IHDR') {
      assert.equal(data.readUInt32BE(0), 1); assert.equal(data.readUInt32BE(4), 1);
      assert.equal(data[8], 8); assert.equal(data[9], 4); // 8-bit grayscale + alpha
    }
    if (kind === 'IDAT') {
      const decoded = inflateSync(data);
      assert.equal(decoded.length, 3); assert.ok(decoded[0]! <= 4);
    }
    offset += length + 12;
  }
  assert.equal(offset, png.length);
  assert.deepEqual(chunks, ['IHDR', 'IDAT', 'IEND']);
});
