// Fixed CLI entry. Parse the actual request once; imports never execute requests.
import fs from 'node:fs';
import { runFileWorker } from './mxc-file-worker.mjs';
import { runFileMutationRequest } from './mxc-file-mutation-worker.mjs';
import { runFileObservationRequest } from './mxc-file-observation-worker.mjs';
import { FILE_RPC_REQUEST_BYTES } from '../files/file-operation-limits.mjs';
import { boundedReason } from '../files/file-tree-core.mjs';
let request;
try {
  const file = process.argv[2];
  if (fs.statSync(file).size > FILE_RPC_REQUEST_BYTES) throw new Error('Request exceeds its actual byte budget');
  const serialized = fs.readFileSync(file, 'utf8'); request = JSON.parse(serialized);
  if (request?.rpc === 'file-mutation-v3') process.stdout.write(await runFileMutationRequest(request, serialized));
  else if (request?.rpc === 'file-observation-v1') process.stdout.write(await runFileObservationRequest(request, serialized));
  else runFileWorker(request);
} catch (error) {
  // A fatal observation/cleanup failure after an execute dispatch never claims
  // no effects. The host also rejects this unpaired reply as transport loss.
  process.stdout.write(JSON.stringify({ ok: false, phase: 'request', noEffects: request?.rpc !== 'file-mutation-v3' || request?.phase !== 'execute',
    error: boundedReason(error instanceof Error ? error.message : String(error)) }));
  process.exitCode = 1;
}
