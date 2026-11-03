export default function (pi) {
  pi.on('session_start', (_event, ctx) => {
    if (process.env.ALPHA_EXIT_KIND?.startsWith('project-')) process.stderr.write(`ALPHA_PROJECT_TRUST:${ctx.isProjectTrusted()}\n`);
    if (process.env.ALPHA_EXIT_KIND === 'quit') ctx.ui.setWidget('alpha-exit-residue', ['ALPHA_RENDER_RESIDUE']);
    ctx.ui.setTitle('ALPHA_CLI_READY');
    if (process.env.ALPHA_EXIT_KIND === 'startup-quit') ctx.shutdown();
    if (process.env.ALPHA_EXIT_KIND === 'extension') setTimeout(() => ctx.shutdown(), 50);
  });
  pi.on('session_shutdown', () => { process.stderr.write('ALPHA_SESSION_SHUTDOWN\n'); });
}
