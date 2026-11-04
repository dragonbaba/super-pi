import { AgentSessionRuntime } from '../../packages/coding-agent/src/core/agent-session-runtime.ts';
import { AgentSession } from '../../packages/coding-agent/src/core/agent-session.ts';
import { tmpdir } from 'node:os';

let runtime, retainedSession;
let runtimeCalls = 0, sessionCalls = 0, completed = false, networkCalls = 0, uncaught = 0, unhandledRejections = 0;
const disposeRuntime = AgentSessionRuntime.prototype.dispose, disposeSession = AgentSession.prototype.dispose;
const initialTerm = process.listeners('SIGTERM'), initialHup = process.listeners('SIGHUP');
const originalEmit = process.emit;
function finished() { completed = true; }
AgentSessionRuntime.prototype.dispose = function () {
  runtime = this; runtimeCalls++;
  return disposeRuntime.call(this).then(finished, error => { finished(); throw error; });
};
AgentSession.prototype.dispose = function () {
  retainedSession = this; sessionCalls++;
  return disposeSession.call(this);
};
globalThis.fetch = function () { networkCalls++; throw new Error('fixture forbids real network'); };
process.on('uncaughtExceptionMonitor', () => { uncaught++; });
process.emit = function (event) {
  if (event === 'unhandledRejection') unhandledRejections++;
  return Reflect.apply(originalEmit, this, arguments);
};
process.on('exit', code => {
  process.emit = originalEmit;
  process.stderr.write('RESULT_EXIT:' + JSON.stringify({ code, runtimeCalls, sessionCalls, completed, networkCalls, uncaught, unhandledRejections,
    tmpdir: tmpdir(), signalListeners: process.listeners('SIGTERM').filter(listener => !initialTerm.includes(listener)).length +
      process.listeners('SIGHUP').filter(listener => !initialHup.includes(listener)).length,
    callbacksReleased: runtime?.resolveDispose === undefined && runtime?.rejectDispose === undefined && runtime?.rebindSession === undefined,
    idleReleased: retainedSession?._idleWaitPromise === undefined && retainedSession?._resolveIdleWait === undefined,
  }) + '\n');
});
