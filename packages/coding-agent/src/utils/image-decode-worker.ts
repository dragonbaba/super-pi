import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import { loadPhoton } from "./photon.ts";

// One bounded validation operation; no network, filesystem image paths, or cache.
const { bytes, observe } = workerData as { bytes: Uint8Array; observe: boolean };
const photon = await loadPhoton();
if (!photon) throw new Error("本地图像校验器不可用，请修复安装后重新添加");
let decoded;
let active = 0;
const start = performance.now();
if (observe) parentPort!.postMessage({ type: "decode-start", at: start });
try {
	decoded = photon.PhotonImage.new_from_byteslice(bytes); active++;
	parentPort!.postMessage({ type: "result", width: decoded.get_width(), height: decoded.get_height() });
} catch {
	throw new Error("图片损坏或无法解码，请重新添加");
} finally {
	if (decoded) { decoded.free(); active--; }
	if (observe) {
		const wasm = createRequire(import.meta.url)("@silvia-odwyer/photon-node").__wasm;
		parentPort!.postMessage({ type: "decode-end", at: performance.now(), elapsed: performance.now() - start, active,
			wasmBytes: wasm.memory.buffer.byteLength, rss: process.memoryUsage.rss() });
	}
	parentPort!.close();
}
