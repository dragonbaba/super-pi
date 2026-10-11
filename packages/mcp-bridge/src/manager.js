import { sanitizeText } from "./security.js";

function serverDetails(server, runtime) {
  const state = runtime?.states.get(server.id);
  return `${server.id}: ${state?.status ?? (server.enabled ? "not started" : "disabled")}\n`
    + `Source: ${server.source}; transport: ${server.transport}; tools: ${state?.tools.size ?? 0}`
    + (state?.error ? `\n${sanitizeText(state.error, 240)}` : "");
}

// Explicit command only: each choice takes a fresh snapshot, without polling or
// subscribing a UI callback to connection/progress events.
export async function chooseMcpAction(config, runtime, configError, ctx, signal) {
  const servers = config?.servers ?? [];
  while (!signal.aborted) {
    const labels = [];
    for (const server of servers) {
      const state = runtime?.states.get(server.id);
      labels.push(`${server.id} — ${state?.status ?? (server.enabled ? "not started" : "disabled")}; ${state?.tools.size ?? 0} tools`);
    }
    const choice = await ctx.ui.select("MCP servers", [...labels, "Refresh status", "Reload configuration"], {
      signal,
      details: configError ? `Configuration error: ${configError}`
        : `${servers.length ? "Select a server to inspect tools or manage authorization." : "No MCP servers are configured."}\nRefresh status updates this snapshot. Escape closes the manager.`,
    });
    if (signal.aborted || choice === undefined) return;
    if (choice === "Refresh status") continue;
    if (choice === "Reload configuration") return { action: "reload" };
    const server = servers[labels.indexOf(choice)];
    if (!server) return;
    while (!signal.aborted) {
      const actions = ["Back", "View tools", "Refresh status"];
      if (server.oauth) actions.push("Sign in", "Sign out");
      const action = await ctx.ui.select(`MCP: ${server.id}`, actions, { signal, details: serverDetails(server, runtime) });
      if (signal.aborted || action === undefined) return;
      if (action === "Back") break;
      if (action === "Refresh status") continue;
      if (action === "Sign in" || action === "Sign out") return { action: action === "Sign in" ? "login" : "logout", id: server.id };
      if (action === "View tools") {
        const names = [];
        const state = runtime?.states.get(server.id);
        if (state) for (const name of state.tools.keys()) names.push(sanitizeText(name, 160));
        await ctx.ui.select(`MCP tools: ${server.id}`, ["Back"], {
          signal, details: names.length ? names.join("\n") : "No tools are available. Refresh status after discovery finishes.",
        });
        if (signal.aborted) return;
      }
    }
  }
}

// The existing auth owner supplies cancellation and owns this entire promise,
// including selector disposal and auth cleanup. No detached UI/auth work.
export async function withMcpAuthProgress(ctx, title, signal, cancel, run) {
  let view;
  let settled = false;
  let failed = false;
  let failure;
  let details = "Working… Escape or Cancel stops this operation.";
  const showUrl = (url) => {
    if (signal.aborted || settled) return;
    details = `Open this URL to authorize:\n${sanitizeText(url, 16384)}\n\nWaiting for authorization. Escape or Cancel stops this operation.`;
    view?.abort();
  };
  // Attach the rejection observer before opening any dialog.
  const pending = Promise.resolve().then(() => { signal.throwIfAborted(); return run(showUrl); }).then(
    () => { settled = true; view?.abort(); },
    error => { failed = true; failure = error; settled = true; view?.abort(); },
  );
  try {
    while (!settled && !signal.aborted) {
      view = new AbortController();
      await ctx.ui.select(title, ["Cancel"], { signal: AbortSignal.any([signal, view.signal]), details });
      if (!settled && !view.signal.aborted && !signal.aborted) { cancel(); break; }
    }
  } finally {
    if (!settled) cancel();
    view?.abort();
    await pending;
  }
  signal.throwIfAborted();
  if (failed) throw failure;
}
