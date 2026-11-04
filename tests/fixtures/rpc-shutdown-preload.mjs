import { AgentSessionRuntime } from '../../packages/coding-agent/src/core/agent-session-runtime.ts';
import { AgentSession } from '../../packages/coding-agent/src/core/agent-session.ts';
import { tmpdir } from 'node:os';

let runtime;
let runtimeCalls = 0;
let sessionCalls = 0;
let disposed = false;
let networkCalls = 0;
const initialEndListeners = process.stdin.listeners('end');
const initialDataListeners = process.stdin.listeners('data');
const disposeRuntime = AgentSessionRuntime.prototype.dispose;
const disposeSession = AgentSession.prototype.dispose;
AgentSessionRuntime.prototype.dispose = function () {
  runtime = this;
  runtimeCalls++;
  return disposeRuntime.call(this).then(() => { disposed = true; });
};
AgentSession.prototype.dispose = function () {
  sessionCalls++;
  return disposeSession.call(this);
};
if (process.env.RPC_SHUTDOWN_CASE === 'preflight-error') {
  // Fault injection at admission, before any provider call. Keep the real RPC
  // response callback and shutdown/runtime owners in control of cleanup.
  AgentSession.prototype.prompt = function (_text, options) {
    this._extensionShutdownHandler();
    options?.preflightResult?.(false);
    return Promise.reject(new Error('fixture preflight rejection'));
  };
}
globalThis.fetch = function () { networkCalls++; throw new Error('RPC fixture forbids network access'); };
process.on('exit', code => {
  process.stderr.write('RPC_EXIT:' + JSON.stringify({ code, runtimeCalls, sessionCalls, disposed, networkCalls,
    tmpdir: tmpdir(), dataListeners: process.stdin.listeners('data').filter(listener => !initialDataListeners.includes(listener)).length,
    endListeners: process.stdin.listeners('end').filter(listener => !initialEndListeners.includes(listener)).length,
    callbacksReleased: runtime?.resolveDispose === undefined && runtime?.rejectDispose === undefined && runtime?.rebindSession === undefined,
  }) + '\n');
});
