// Offline benchmark extension. No provider request or production registration.
export default function (pi) {
    pi.registerCommand('pf-lifecycle-ready', {
        description: 'Acknowledge benchmark input without starting an agent turn',
        handler: async () => { process.stderr.write('PF_INPUT_ACK:' + JSON.stringify({ activeTools: pi.getActiveTools().length, commands: pi.getCommands().length }) + '\n'); },
    });
    pi.on('session_start', (_event, ctx) => { ctx.ui.setTitle('PF_SESSION_START'); });
    pi.on('session_shutdown', () => { process.stderr.write('PF_SESSION_SHUTDOWN\n'); });
}
