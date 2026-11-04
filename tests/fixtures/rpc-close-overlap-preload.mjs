import { AgentSessionRuntime } from '../../packages/coding-agent/src/core/agent-session-runtime.ts';
import { AgentSession } from '../../packages/coding-agent/src/core/agent-session.ts';
import { tmpdir } from 'node:os';

let runtime, retainedSession;
let runtimeCalls = 0, sessionCalls = 0, completed = false, networkCalls = 0, uncaught = 0;
let unhandledRejections = 0;
const initialEnd = process.stdin.listeners('end');
const initialData = process.stdin.listeners('data');
let initialSignals = [];
const originalEmit = process.emit;
const disposeRuntime = AgentSessionRuntime.prototype.dispose;
const disposeSession = AgentSession.prototype.dispose;
const bindExtensions = AgentSession.prototype.bindExtensions;
AgentSession.prototype.bindExtensions = function () {
  // RPC registers its signal handlers only after this initial binding completes.
  initialSignals = process.listeners('SIGTERM');
  return Reflect.apply(bindExtensions, this, arguments);
};
function onEof() { process.stderr.write('CLOSE_EOF\n'); }
process.stdin.once('end', onEof);
// Observe actual delivered signals without installing another signal listener:
// a removed production handler must still expose the OS default termination.
process.emit = function (event) {
  if (event === 'unhandledRejection') unhandledRejections++;
  const result = Reflect.apply(originalEmit, this, arguments);
  if (event === 'SIGTERM') process.stderr.write('CLOSE_SIGNAL\n');
  return result;
};
function finished() {
  completed = true;
  process.stdin.off('end', onEof);
}
AgentSessionRuntime.prototype.dispose = function () {
  runtime = this; runtimeCalls++;
  return disposeRuntime.call(this).then(finished, error => { finished(); throw error; });
};
AgentSession.prototype.dispose = function () {
  retainedSession = this; sessionCalls++;
  const result = disposeSession.call(this);
  if (process.env.RPC_CLOSE_CASE === 'eof-error') throw new Error('fixture dispose failure');
  return result;
};
globalThis.fetch = function () { networkCalls++; throw new Error('fixture forbids real network'); };
process.on('uncaughtExceptionMonitor', () => { uncaught++; });
process.on('exit', code => {
  process.emit = originalEmit;
  process.stderr.write('CLOSE_EXIT:' + JSON.stringify({ code, runtimeCalls, sessionCalls, completed, networkCalls, uncaught, unhandledRejections,
    tmpdir: tmpdir(), signalListeners: process.listeners('SIGTERM').filter(listener => !initialSignals.includes(listener)).length,
    dataListeners: process.stdin.listeners('data').filter(listener => !initialData.includes(listener)).length,
    endListeners: process.stdin.listeners('end').filter(listener => !initialEnd.includes(listener)).length,
    callbacksReleased: runtime?.resolveDispose === undefined && runtime?.rejectDispose === undefined && runtime?.rebindSession === undefined,
    idleReleased: retainedSession?._idleWaitPromise === undefined && retainedSession?._resolveIdleWait === undefined,
  }) + '\n');
});
