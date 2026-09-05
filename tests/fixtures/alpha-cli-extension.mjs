export default function (pi) {
  pi.on('session_start', (_event, ctx) => {
    ctx.ui.setTitle('ALPHA_CLI_READY');
    if (process.env.ALPHA_EXIT_KIND === 'extension') setTimeout(() => ctx.shutdown(), 50);
  });
  pi.on('session_shutdown', () => { process.stderr.write('ALPHA_SESSION_SHUTDOWN\n'); });
}
