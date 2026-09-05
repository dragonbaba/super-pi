// Explicit --import diagnostic. No production import and no work when disabled.
// Reports fixed phase labels and scalar values only; never errors/messages/paths.
if (process.env.SP_ALPHA_STARTUP_CAPTURE) {
  const { openSync, writeSync, closeSync } = await import('node:fs');
  const { resolve, dirname, join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const fd = openSync(process.env.SP_ALPHA_STARTUP_CAPTURE, 'wx', 0o600);
  const origin = performance.now();
  let records = 0;
  let closed = false;
  const allowedCodes = new Set(['ENOENT', 'EACCES', 'EPERM', 'EPIPE', 'EIO', 'EINVAL', 'ECONNRESET', 'ETIMEDOUT', 'ABORT_ERR']);
  function record(phase, duration, error, generation = 0) {
    if (closed || records >= 256) return;
    const code = error ? (allowedCodes.has(error.code) ? error.code : 'ERROR') : undefined;
    writeSync(fd, JSON.stringify({ phase, duration, errorCode: code, generation }) + '\n');
    records++;
  }
  function onUncaught(error) { record('uncaught', performance.now() - origin, error); }
  function onExit() {
    record('process-exit', performance.now() - origin);
    closed = true; closeSync(fd);
  }
  process.on('uncaughtExceptionMonitor', onUncaught);
  process.once('exit', onExit);
  record('capture-entry', 0);
  const directory = dirname(resolve(process.argv[1]));
  try {
    // Select the same dist module as the actual CLI, including an explicitly
    // selected read-only manual checkout. The diagnostic does not edit it.
    const { InteractiveMode } = await import(pathToFileURL(join(directory, 'modes/interactive/interactive-mode.js')).href);
    function wrap(owner, method, phase, mode, asynchronous) {
      const original = owner[method];
      if (typeof original !== 'function') throw new Error('unsupported diagnostic target');
      if (asynchronous) owner[method] = async function (...args) {
        const start = performance.now();
        try { const result = await original.apply(this, args); record(phase, performance.now() - start, undefined, mode.initializationGeneration); return result; }
        catch (error) { record(phase, performance.now() - start, error, mode.initializationGeneration); throw error; }
      };
      else owner[method] = function (...args) {
        const start = performance.now();
        try { const result = original.apply(this, args); record(phase, performance.now() - start, undefined, mode.initializationGeneration); return result; }
        catch (error) { record(phase, performance.now() - start, error, mode.initializationGeneration); throw error; }
      };
      return original;
    }
    const init = InteractiveMode.prototype.init;
    InteractiveMode.prototype.init = async function (...args) {
      const start = performance.now();
      record('interactive-init-entry', start - origin, undefined, this.initializationGeneration);
      const restore = [];
      const targets = [
        [this, 'ensureInitializationTools', 'ensure-tools', true],
        [this, 'mountInteractiveTui', 'tui-mount', false],
        [this.ui, 'start', 'tui-start', false],
        [this.themeController, 'applyFromSettings', 'theme-apply', true],
        [this, 'rebindCurrentSession', 'extension-rebind', true],
        [this, 'renderInitialMessages', 'initial-history', false],
        [this.footerDataProvider, 'onBranchChange', 'branch-watcher', false],
        [this, 'updateAvailableProviderCount', 'provider-count', true],
        [this.ui, 'renderNow', 'first-render', false],
        [this, 'loadInitializationHighlightLanguages', 'highlight-loader', true],
      ];
      try {
        for (const [owner, method, phase, asynchronous] of targets) restore.push([owner, method, wrap(owner, method, phase, this, asynchronous)]);
        const ready = await init.apply(this, args);
        record(ready ? 'input-ready' : 'startup-cancelled', performance.now() - start, undefined, this.initializationGeneration);
        return ready;
      } catch (error) { record('startup-failed', performance.now() - start, error, this.initializationGeneration); throw error; }
      finally { for (const [owner, method, original] of restore) owner[method] = original; }
    };
  } catch (error) { record('capture-setup-failed', performance.now() - origin, error); throw error; }
}
