import {
	type Component,
	Container,
	fuzzyFilter,
	getKeybindings,
	Input,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	Spacer,
	Text,
} from "@super-pi/tui";
import { getSelectListTheme, theme } from "../theme/theme.ts";

const SUBMENU_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

function getSelectItemSearchText(item: SelectItem): string {
	return `${item.label} ${item.description ?? ""}`;
}

export interface SelectSubmenuOptions {
	searchable?: boolean;
	layout?: SelectListLayoutOptions;
}

/** Single-step settings submenu with optional fuzzy filtering. */
export class SelectSubmenu extends Container {
	private readonly allOptions: SelectItem[];
	private readonly searchInput: Input | undefined;
	private readonly selectList: SelectList;
	private filterQuery = "";

	constructor(
		title: string,
		description: string,
		options: SelectItem[],
		currentValue: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
		onSelectionChange?: (value: string) => void,
		submenuOptions?: SelectSubmenuOptions,
	) {
		super();
		this.allOptions = options;
		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));
		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}

		if (submenuOptions?.searchable) {
			this.addChild(new Spacer(1));
			this.searchInput = new Input();
			this.addChild(this.searchInput);
		}
		this.addChild(new Spacer(1));

		this.selectList = new SelectList(
			options,
			Math.min(options.length, 10),
			getSelectListTheme(),
			submenuOptions?.layout ?? SUBMENU_SELECT_LIST_LAYOUT,
		);
		for (let index = 0; index < options.length; index++) {
			if (options[index]?.value !== currentValue) continue;
			this.selectList.setSelectedIndex(index);
			break;
		}
		this.selectList.onSelect = (item) => onSelect(item.value);
		this.selectList.onCancel = onCancel;
		if (onSelectionChange) {
			this.selectList.onSelectionChange = (item) => onSelectionChange(item.value);
		}
		if (this.searchInput) this.searchInput.onSubmit = () => this.selectList.handleInput("\r");
		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"dim",
					submenuOptions?.searchable
						? "  Type to filter · Enter to select · Esc to go back"
						: "  Enter to select · Esc to go back",
				),
				0,
				0,
			),
		);
	}

	private applyFilter(query: string): void {
		if (query === this.filterQuery) return;
		this.filterQuery = query;
		const selectedValue = this.selectList.getSelectedItem()?.value;
		const filtered = query ? fuzzyFilter(this.allOptions, query, getSelectItemSearchText) : this.allOptions;
		this.selectList.setItems(filtered, selectedValue);
	}

	handleInput(data: string): void {
		if (!this.searchInput) {
			this.selectList.handleInput(data);
			return;
		}
		const keybindings = getKeybindings();
		if (
			keybindings.matches(data, "tui.select.up") ||
			keybindings.matches(data, "tui.select.down") ||
			keybindings.matches(data, "tui.select.confirm") ||
			keybindings.matches(data, "tui.select.cancel")
		) {
			this.selectList.handleInput(data);
			return;
		}
		this.searchInput.handleInput(data);
		this.applyFilter(this.searchInput.getValue());
	}
}

export interface SteppedSubmenuStep {
	key: string;
	title: string | ((context: Record<string, string>) => string);
	description: string | ((context: Record<string, string>) => string);
	options: (context: Record<string, string>) => SelectItem[];
	preselect?: (context: Record<string, string>) => string | undefined;
	searchable?: boolean;
	layout?: SelectListLayoutOptions;
}

interface SteppedSubmenuOptions {
	startAtStep?: number;
	initialContext?: Record<string, string>;
	loop?: boolean;
}

/** Reusable multi-step settings selector. */
export class SteppedSubmenu extends Container {
	private readonly steps: SteppedSubmenuStep[];
	private readonly onComplete: (context: Record<string, string>) => void;
	private readonly onCancel: () => void;
	private readonly options: SteppedSubmenuOptions;
	private activeComponent: Component;
	private context: Record<string, string>;

	constructor(
		steps: SteppedSubmenuStep[],
		onComplete: (context: Record<string, string>) => void,
		onCancel: () => void,
		options: SteppedSubmenuOptions = {},
	) {
		super();
		this.steps = steps;
		this.onComplete = onComplete;
		this.onCancel = onCancel;
		this.options = options;
		this.context = { ...(options.initialContext ?? {}) };
		this.activeComponent = this.buildStep(options.startAtStep ?? 0);
		this.children.push(this.activeComponent);
	}

	private setActiveComponent(component: Component): void {
		this.activeComponent = component;
		this.children[0] = component;
	}

	private buildStep(stepIndex: number): Component {
		const step = this.steps[stepIndex]!;
		const title = typeof step.title === "function" ? step.title(this.context) : step.title;
		const description =
			typeof step.description === "function" ? step.description(this.context) : step.description;
		const stepLabel = this.steps.length > 1 ? `Step ${stepIndex + 1}/${this.steps.length} · ` : "";
		return new SelectSubmenu(
			title,
			`${stepLabel}${description}`,
			step.options(this.context),
			step.preselect?.(this.context) ?? "",
			(value) => {
				this.context[step.key] = value;
				if (stepIndex < this.steps.length - 1) {
					this.setActiveComponent(this.buildStep(stepIndex + 1));
					return;
				}
				this.onComplete({ ...this.context });
				if (this.options.loop) {
					this.context = {};
					this.setActiveComponent(this.buildStep(0));
				} else {
					this.onCancel();
				}
			},
			() => {
				if (stepIndex === 0) {
					this.onCancel();
					return;
				}
				const previousContext: Record<string, string> = {};
				const contextKeys = Object.keys(this.context);
				for (let index = 0; index < contextKeys.length; index++) {
					const key = contextKeys[index]!;
					if (key === step.key) continue;
					previousContext[key] = this.context[key]!;
				}
				this.context = previousContext;
				this.setActiveComponent(this.buildStep(stepIndex - 1));
			},
			undefined,
			step.searchable || step.layout ? { searchable: step.searchable, layout: step.layout } : undefined,
		);
	}

	render(width: number): string[] {
		return this.activeComponent.render(width);
	}

	handleInput(data: string): void {
		this.activeComponent.handleInput?.(data);
	}

	invalidate(): void {
		this.activeComponent.invalidate?.();
	}
}
