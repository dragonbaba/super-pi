// Explicit diagnostic preload only. Loading InteractiveMode here changes module
// order; compare with the no-probe arm instead of treating its time as production.
function record(phase, durationMs) {
    process.stderr.write('PF_PHASE:' + JSON.stringify({ phase, durationMs }) + '\n');
}
const importStart = performance.now();
const { InteractiveMode } = await import('../../packages/coding-agent/dist/modes/interactive/interactive-mode.js');
const { ProcessTerminal } = await import('../../packages/tui/dist/terminal.js');
record('preload-import', performance.now() - importStart);
function wrap(owner, name, phase) {
    const original = owner[name];
    if (typeof original !== 'function') throw new Error('Unsupported lifecycle probe target: ' + name);
    owner[name] = async function (...args) {
        const started = performance.now();
        const result = await original.apply(this, args);
        record(phase, performance.now() - started);
        return result;
    };
}
wrap(ProcessTerminal.prototype, 'drainInput', 'drain-input');
wrap(InteractiveMode.prototype, 'stop', 'stop-ui');
const originalInit = InteractiveMode.prototype.init;
InteractiveMode.prototype.init = async function (...args) {
    record('init-entry-process-age', process.uptime() * 1000);
    const started = performance.now();
    const ready = await originalInit.apply(this, args);
    record(ready ? 'init-complete' : 'init-cancelled', performance.now() - started);
    record('init-settled-process-age', process.uptime() * 1000);
    return ready;
};
