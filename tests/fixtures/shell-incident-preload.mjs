// Explicit isolated diagnostic only; never loaded by the product.
import fs from 'node:fs';
import cp from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const report = process.env.SP_INCIDENT_REPORT;
const record = data => fs.appendFileSync(report, JSON.stringify(data) + '\n');
let network = 0, spawns = 0, session;
function blocked() { network++; throw new Error('Isolated incident fixture forbids network'); }
globalThis.fetch = blocked;
http.request = http.get = https.request = https.get = blocked;
net.connect = net.createConnection = tls.connect = blocked;
const spawn = cp.spawn;
cp.spawn = function observedSpawn(file, args, options) {
  if (globalThis.__shellIncidentToolActive === true) {
    spawns++;
    record({ phase: 'spawn', file, args, cwd: options?.cwd, shell: options?.shell ?? false,
      windowsVerbatimArguments: options?.windowsVerbatimArguments ?? false,
      bridge: options?.env?.SP_MSYS_STDIN_COMMAND_B64 ?? null });
  }
  return spawn.apply(this, arguments);
};
syncBuiltinESMExports();
const { AgentSession } = await import(pathToFileURL(join(process.env.SP_INCIDENT_PROJECT, 'packages/coding-agent/dist/core/agent-session.js')).href);
const bind = AgentSession.prototype.bindExtensions;
const dispose = AgentSession.prototype.dispose;
AgentSession.prototype.dispose = function observedDispose() {
  record({ phase: 'release', pending: this.agent.state.pendingToolCalls.size,
    authorizations: this.extensionRunner?.finalAuthorizations?.size ?? 0,
    authorizationMapAllocated: this.extensionRunner?.finalAuthorizations !== undefined });
  return dispose.apply(this, arguments);
};
AgentSession.prototype.bindExtensions = async function fixtureApproval(bindings) {
  session = this;
  return bind.call(this, { ...bindings, mode: 'tui', uiContext: {
    ...this.extensionRunner.getUIContext(), select: async (header, choices, options) => {
      record({ phase: 'approval', header, details: options?.details, choices });
      return process.env.SP_INCIDENT_DENY === '1' ? '拒绝' : '仅允许本次';
    },
  } });
};
record({ phase: 'runtime', node: process.version, executable: process.execPath });
process.on('exit', () => {
  record({ phase: 'exit', network, spawns, pending: session?.agent.state.pendingToolCalls.size,
    authorizations: session?.extensionRunner?.finalAuthorizations?.size,
    launcher: process.env.SP_SOURCE_LAUNCHER });
  if (network) process.exitCode = 1;
});
