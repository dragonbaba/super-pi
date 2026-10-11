/** Opt-in expressions; the existing SDK tools/excludeTools lists stay literal. */
export interface ToolSelectionOptions {
	tools?: readonly string[];
	excludeTools?: readonly string[];
}

/** Whole-name glob matching without regex compilation or per-name allocations. */
export function matchesToolPattern(name: string, pattern: string): boolean {
	let input = 0, token = 0, star = -1, retry = 0;
	while (input < name.length) {
		if (token < pattern.length && pattern[token] !== "*" && (pattern[token] === "?" || pattern[token] === name[input])) {
			input++; token++;
		} else if (pattern[token] === "*") {
			star = token++; retry = input;
		} else if (star >= 0) {
			token = star + 1; input = ++retry;
		} else return false;
	}
	while (pattern[token] === "*") token++;
	return token === pattern.length;
}

/** One bounded owner per session; only used at tool-registry lifecycle boundaries. */
export class ToolSelection {
	readonly usesDefaults: boolean;
	private readonly include: string[] = [];
	private readonly exclude: string[] = [];
	private readonly defaultAllowed: boolean;

	constructor(options: ToolSelectionOptions, suppressDefaults = false) {
		let terms = 0, chars = 0, bare = false;
		for (const list of [options.tools, options.excludeTools]) {
			if (!list) continue;
			for (const term of list) {
				if (typeof term !== "string" || !term.length || term.length > 1024) throw new Error("Tool selection terms must contain 1..1024 characters");
				chars += term.length;
				if (++terms > 256 || chars > 16384) throw new Error("Tool selection exceeds 256 terms or 16384 characters");
			}
		}
		for (const term of options.tools ?? []) {
			const signed = term[0] === "+" || term[0] === "-";
			const pattern = signed ? term.slice(1) : term;
			if (!pattern.length) throw new Error("Tool selection + or - requires a name or pattern");
			if (term[0] === "-") this.exclude.push(pattern);
			else { this.include.push(pattern); if (!signed) bare = true; }
		}
		for (const pattern of options.excludeTools ?? []) this.exclude.push(pattern);
		this.usesDefaults = options.tools === undefined || options.tools.length > 0 && !bare;
		this.defaultAllowed = this.usesDefaults && !suppressDefaults;
		if (this.excludes("codemode")) throw new Error("codemode is the required default tool transport; use --no-tools to disable tools");
	}

	excludes(name: string): boolean {
		for (let i = 0; i < this.exclude.length; i++) if (matchesToolPattern(name, this.exclude[i]!)) return true;
		return false;
	}

	adds(name: string): boolean {
		if (this.excludes(name)) return false;
		for (let i = 0; i < this.include.length; i++) if (matchesToolPattern(name, this.include[i]!)) return true;
		return false;
	}

	allows(name: string): boolean {
		if (this.defaultAllowed) return !this.excludes(name);
		if (name === "codemode") return this.include.length > 0 && !this.excludes(name);
		return this.adds(name);
	}

	explicitlyAdds(name: string): boolean {
		return !this.excludes(name) && this.include.includes(name);
	}
}
