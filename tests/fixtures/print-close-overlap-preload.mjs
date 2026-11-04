import { AgentSessionRuntime } from '../../packages/coding-agent/src/core/agent-session-runtime.ts';
import { AgentSession } from '../../packages/coding-agent/src/core/agent-session.ts';
import { tmpdir } from 'node:os';

let runtime, retainedSession;
let runtimeCalls = 0, sessionCalls = 0, completed = false, networkCalls = 0, uncaught = 0, unhandledRejections = 0;
const initialTerm = process.listeners('SIGTERM'), initialHup = process.listeners('SIGHUP');
const originalEmit = process.emit;
const disposeRuntime = AgentSessionRuntime.prototype.dispose;
const disposeSession = AgentSession.prototype.dispose;
function onSignal() { process.stderr.write('PRINT_OVERLAP\n'); }
function onMessage(message) {
  if (message === 'arm') {
    process.prependOnceListener('SIGTERM', onSignal);
    process.stderr.write('PRINT_ARMED\n');
  } else if (message === 'first' || message === 'second') {
    process.emit('SIGTERM');
    if (message === 'second') process.stderr.write('PRINT_OVERLAP\n');
  }
}
process.on('message', onMessage);
process.emit = function (event) {
  if (event === 'unhandledRejection') unhandledRejections++;
  return Reflect.apply(originalEmit, this, arguments);
};
function finished() {
  completed = true;
  process.off('message', onMessage);
  process.off('SIGTERM', onSignal);
  if (process.connected) process.disconnect();
}
AgentSessionRuntime.prototype.dispose = function () {
  runtime = this; runtimeCalls++;
  return disposeRuntime.call(this).then(finished, error => { finished(); throw error; });
};
AgentSession.prototype.dispose = function () {
  retainedSession = this; sessionCalls++;
  const result = disposeSession.call(this);
  if (process.env.PRINT_CLOSE_CASE.endsWith('error')) throw new Error('fixture print dispose failure');
  return result;
};
globalThis.fetch = function () { networkCalls++; throw new Error('fixture forbids real network'); };
process.on('uncaughtExceptionMonitor', () => { uncaught++; });
process.on('exit', code => {
  process.emit = originalEmit;
  process.stderr.write('PRINT_EXIT:' + JSON.stringify({ code, runtimeCalls, sessionCalls, completed, networkCalls, uncaught, unhandledRejections,
    tmpdir: tmpdir(), signalListeners: process.listeners('SIGTERM').filter(listener => !initialTerm.includes(listener)).length +
      process.listeners('SIGHUP').filter(listener => !initialHup.includes(listener)).length,
    ipcReleased: !process.listeners('message').includes(onMessage),
    callbacksReleased: runtime?.resolveDispose === undefined && runtime?.rejectDispose === undefined && runtime?.rebindSession === undefined,
    idleReleased: retainedSession?._idleWaitPromise === undefined && retainedSession?._resolveIdleWait === undefined,
  }) + '\n');
});
