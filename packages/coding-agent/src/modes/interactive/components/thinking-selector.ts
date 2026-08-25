import type { ThinkingLevel } from "@super-pi/agent-core";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	matchesKey,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	Spacer,
	Text,
} from "@super-pi/tui";
import { getSelectListTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyDisplayText } from "./keybinding-hints.ts";

const THINKING_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

const LEVEL_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning (~1k tokens)",
	low: "Light reasoning (~2k tokens)",
	medium: "Moderate reasoning (~8k tokens)",
	high: "Deep reasoning (~16k tokens)",
	xhigh: "Extra-high reasoning (~32k tokens)",
	max: "Maximum reasoning",
};

function getThinkingItemSearchText(item: SelectItem): string {
	return `${item.label} ${item.description ?? ""}`;
}

export class ThinkingSelectorComponent extends Container implements Focusable {
	private searchInput: Input;
	private selectList: SelectList;
	private allItems: SelectItem[];
	private onSelect: (level: ThinkingLevel) => void;
	private onCancel: () => void;
	private onSelectAsDefault?: (level: ThinkingLevel) => void;
	private _focused = false;
	private filterQuery = "";

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		currentLevel: ThinkingLevel,
		availableLevels: ThinkingLevel[],
		onSelect: (level: ThinkingLevel) => void,
		onCancel: () => void,
		onSelectAsDefault?: (level: ThinkingLevel) => void,
		defaultThinkingLevel?: ThinkingLevel,
	) {
		super();
		this.onSelect = onSelect;
		this.onCancel = onCancel;
		this.onSelectAsDefault = onSelectAsDefault;
		this.allItems = new Array<SelectItem>(availableLevels.length);
		for (let index = 0; index < availableLevels.length; index++) {
			const level = availableLevels[index]!;
			this.allItems[index] = {
				value: level,
				label: level,
				description:
					level === defaultThinkingLevel ? `${LEVEL_DESCRIPTIONS[level]} · default` : LEVEL_DESCRIPTIONS[level],
			};
		}

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text("Thinking Level", 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(`${keyDisplayText("app.thinking.cycle")} cycles thinking levels in-session`, 0, 0));
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		this.searchInput.onSubmit = () => this.selectList.handleInput("\r");
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		this.selectList = new SelectList(
			this.allItems,
			Math.max(1, this.allItems.length),
			getSelectListTheme(),
			THINKING_SELECT_LIST_LAYOUT,
		);
		for (let index = 0; index < this.allItems.length; index++) {
			if (this.allItems[index]?.value !== currentLevel) continue;
			this.selectList.setSelectedIndex(index);
			break;
		}
		this.selectList.onSelect = (item) => this.onSelect(item.value as ThinkingLevel);
		this.selectList.onCancel = () => this.onCancel();
		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to select · Ctrl+S to set as default · Esc to cancel"), 0, 0));
		this.addChild(new DynamicBorder());
	}

	private applyFilter(query: string): void {
		if (query === this.filterQuery) return;
		this.filterQuery = query;
		const filtered = query ? fuzzyFilter(this.allItems, query, getThinkingItemSearchText) : this.allItems;
		const selectedValue = this.selectList.getSelectedItem()?.value as ThinkingLevel | undefined;
		this.selectList.setItems(filtered, selectedValue);
	}

	handleInput(keyData: string): void {
		if (matchesKey(keyData, "ctrl+s") && this.onSelectAsDefault) {
			const item = this.selectList.getSelectedItem();
			if (item) this.onSelectAsDefault(item.value as ThinkingLevel);
			return;
		}

		const kb = getKeybindings();
		const isNavigation =
			kb.matches(keyData, "tui.select.up") ||
			kb.matches(keyData, "tui.select.down") ||
			kb.matches(keyData, "tui.select.confirm") ||
			kb.matches(keyData, "tui.select.cancel");
		if (isNavigation) {
			this.selectList.handleInput(keyData);
			return;
		}

		this.searchInput.handleInput(keyData);
		this.applyFilter(this.searchInput.getValue());
	}

	getSelectList(): SelectList {
		return this.selectList;
	}
}
