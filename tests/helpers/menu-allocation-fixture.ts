export const menuScenes: any[] = [
	{ kind: "choice", title: "Choose", lines: ["Context\tline"], items: [{ id: "a", label: "First", description: "description", details: ["", "multiline\nnext"] }, { id: "b", label: "Disabled", disabled: true, disabledReason: "blocked" }] },
	{ kind: "choice", title: "Empty", items: [] },
	{ kind: "settings", title: "Settings", items: [{ id: "a", label: "Long label", currentValue: "yes", values: ["yes", "no"] }, { id: "b", label: "Short", currentValue: "off", disabled: true }] },
	{ kind: "browse", title: "Browse", lines: ["Context"], items: [{ id: "a", label: "Alpha", statusText: "enabled", description: "detail", details: ["multi\nline"] }, { id: "b", label: "Beta", statusText: "disabled" }], enableSearch: true },
	{ kind: "multiSelect", title: "Multiple", items: [{ id: "a", label: "Alpha", selected: true, description: "desc" }, { id: "b", label: "Beta", selected: false, disabled: true, disabledReason: "blocked" }], actions: [{ id: "done", label: "Done" }], enableSearch: true },
	{ kind: "review", title: "Review", lines: ["Context"], content: "@@ header\n+added\n-removed\n \t😀中文\n", format: { kind: "diff" }, viewportSize: "adaptive" },
	{ kind: "review", title: "Code", content: "const text = 'a&b';\n// comment\n", format: { kind: "code", language: "typescript" }, viewportSize: "adaptive" },
];

const keys: Record<string, string[]> = { "tui.select.up": ["up"], "tui.select.down": ["down"], "tui.select.pageUp": ["pageUp"], "tui.select.pageDown": ["pageDown"], "tui.select.confirm": ["enter"], "tui.select.cancel": ["escape", "ctrl+c"], "tui.input.submit": ["enter"] };
export function menuOptions(screen: any, rows: number, events: any[] = []): any {
	return {
		screen, tui: { terminal: { rows }, requestRender() {} },
		theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
		keybindings: { matches: (data: string, binding: string) => keys[binding]?.includes(data) ?? false, getKeys: (binding: string) => keys[binding] ?? [] },
		onEvent: (event: any) => events.push(event),
	};
}

export const syntaxScenes = [
	{ code: "const text = 'a&b';\n// comment", language: "typescript" },
	{ code: "<div attr=\"x\">&amp;</div>", language: "html" },
	{ code: "**bold** *italic* [link](url)", language: "markdown" },
	{ code: "x > y", language: undefined },
	{ code: "malformed😀", language: "nonexistent" },
];
export const syntaxTheme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bold: (text: string) => `<bold>${text}</bold>`, italic: (text: string) => `<italic>${text}</italic>`, underline: (text: string) => `<underline>${text}</underline>` };
