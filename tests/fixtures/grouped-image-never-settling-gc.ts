import {
	getCapabilities,
	RELEASE_COMPONENT_RENDER_CACHE,
	setCapabilities,
} from "@super-pi/tui";
import type { ToolResultMessage } from "../../packages/ai/src/types.ts";
import {
	createToolResultPresentationOwner,
	type ToolResultPresentationContent,
} from "../../packages/coding-agent/src/core/tool-result-presentation.ts";
import { ReadToolGroupComponent } from "../../packages/coding-agent/src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";

type ConvertedImage = { data: string; mimeType: string };

const neverSettlingLoader = new Promise<unknown>(() => {});

class NeverSettlingReadToolGroupComponent extends ReadToolGroupComponent {
	protected loadImageConverterForTerminal(): Promise<unknown | null> {
		return neverSettlingLoader as Promise<unknown | null>;
	}

	protected convertImageForTerminal(): Promise<ConvertedImage | null> {
		return neverSettlingLoader as Promise<ConvertedImage | null>;
	}
}

type LifecycleCounts = {
	loaderRequests?: number;
	loaderSourceAcquisitions?: number;
};

function createReleasedWeakReferences(): {
	component: WeakRef<object>;
	row: WeakRef<object>;
	result: WeakRef<object>;
	content: WeakRef<object>;
	block: WeakRef<object>;
	state?: WeakRef<object>;
	counts: LifecycleCounts;
} {
	const group = new NeverSettlingReadToolGroupComponent(true, 32);
	const imageBlock = {
		type: "image" as const,
		data: Buffer.alloc(512 * 1024, 0x51).toString("base64"),
		mimeType: "image/jpeg",
	};
	const content: ToolResultPresentationContent[] = [
		{ type: "text", text: "never-settling-grouped-image-".repeat(1_000) },
		imageBlock,
	];
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "never-settling-grouped-image",
		toolName: "read",
		content: content as ToolResultMessage["content"],
		isError: false,
		timestamp: 1,
	};
	const owner = createToolResultPresentationOwner(
		{ enabled: true, budgetTokens: 128 },
		"never-settling-grouped-image",
	)!;
	const presentation = owner.create(result.content, result.toolCallId)!;
	group.updateArgs(result.toolCallId, { path: "large.jpg" });
	group.setArgsComplete(result.toolCallId);
	group.updateResult(result.toolCallId, result);
	group.setToolResultPresentation(result.toolCallId, presentation);
	owner.release();
	group.setExpanded(true);

	const internals = group as unknown as {
		rows: Map<string, object>;
		imageConversions?: Map<object, Array<object | undefined>>;
	};
	const row = internals.rows.get(result.toolCallId)!;
	const state = internals.imageConversions?.get(row)?.[0];
	const counts = group.getGroupedImageConversionLifecycleCounts() as LifecycleCounts;
	const refs = {
		component: new WeakRef<object>(group),
		row: new WeakRef<object>(row),
		result: new WeakRef<object>(result),
		content: new WeakRef<object>(content),
		block: new WeakRef<object>(imageBlock),
		state: state ? new WeakRef<object>(state) : undefined,
		counts,
	};
	group[RELEASE_COMPONENT_RENDER_CACHE]();
	owner.dispose();
	return refs;
}

async function forceCollection(): Promise<void> {
	for (let attempt = 0; attempt < 24; attempt++) {
		await new Promise<void>((resolve) => setImmediate(resolve));
		globalThis.gc!();
		new Uint8Array(256 * 1024);
	}
}

if (typeof globalThis.gc !== "function") throw new Error("worker requires --expose-gc");
initTheme("dark");
const previousCapabilities = getCapabilities();
setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
const refs = createReleasedWeakReferences();
await forceCollection();
setCapabilities(previousCapabilities);
process.stdout.write(JSON.stringify({
	componentRetained: refs.component.deref() !== undefined,
	rowRetained: refs.row.deref() !== undefined,
	resultRetained: refs.result.deref() !== undefined,
	contentRetained: refs.content.deref() !== undefined,
	blockRetained: refs.block.deref() !== undefined,
	stateRetained: refs.state?.deref() !== undefined,
	loaderRequests: refs.counts.loaderRequests ?? 1,
	sourceAcquisitions: refs.counts.loaderSourceAcquisitions ?? 1,
}));
