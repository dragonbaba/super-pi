import type { AssistantMessage } from "@super-pi/ai";
import { Container, Markdown, type MarkdownTheme, Spacer, Text } from "@super-pi/tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const thinkingTextColor = (text: string): string => theme.fg("thinkingText", text);

type StreamingMarkdownSlot = {
	markdown: Markdown;
	theme: MarkdownTheme;
	transformers: readonly MarkdownTransformer[];
};

const EMPTY_STREAMING_MARKDOWN_SLOTS: ReadonlyMap<number, StreamingMarkdownSlot> = new Map();

export interface AssistantMessageAllocationMetrics {
	updateContentCalls: number;
	contentScans: number;
	slotRecordObjects: number;
	markdownInstances: number;
	spacerInstances: number;
	textInstances: number;
	currentSpacers: number;
	spacerHwm: number;
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private isStreaming = false;
	private streamingMarkdownSlots = new Map<number, StreamingMarkdownSlot>();
	private nextStreamingMarkdownSlots = new Map<number, StreamingMarkdownSlot>();
	private readonly maxStreamingMarkdownSlots = 4;
	private readonly streamingSpacers: Spacer[] = [];
	private nextStreamingSpacer = 0;
	private readonly allocationMetrics: AssistantMessageAllocationMetrics | undefined;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		allocationMetrics?: AssistantMessageAllocationMetrics,
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.allocationMetrics = allocationMetrics;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setMarkdownTheme(markdownTheme: MarkdownTheme): void {
		if (this.markdownTheme === markdownTheme) return;
		this.markdownTheme = markdownTheme;
		this.streamingMarkdownSlots.clear();
		this.nextStreamingMarkdownSlots.clear();
		if (this.lastMessage) this.updateContent(this.lastMessage);
	}

	setMarkdownTransformers(markdownTransformers: readonly MarkdownTransformer[]): void {
		if (this.markdownTransformers === markdownTransformers) return;
		this.markdownTransformers = markdownTransformers;
		this.streamingMarkdownSlots.clear();
		this.nextStreamingMarkdownSlots.clear();
		if (this.lastMessage) this.updateContent(this.lastMessage);
	}

	setOutputPad(padding: number): void {
		if (this.outputPad === padding) return;
		this.outputPad = padding;
		this.streamingMarkdownSlots.clear();
		this.nextStreamingMarkdownSlots.clear();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		if (this.allocationMetrics) this.allocationMetrics.updateContentCalls++;
		const reusableMarkdownSlots = isStreaming && this.isStreaming
			? this.streamingMarkdownSlots
			: EMPTY_STREAMING_MARKDOWN_SLOTS;
		const nextMarkdownSlots = this.nextStreamingMarkdownSlots;
		nextMarkdownSlots.clear();
		this.lastMessage = message;
		this.isStreaming = isStreaming;
		this.nextStreamingSpacer = 0;

		// Clear content container
		this.contentContainer.children.length = 0;

		let hasVisibleContent = false;
		let hasToolCalls = false;
		if (this.allocationMetrics) this.allocationMetrics.contentScans++;
		for (let contentIndex = 0; contentIndex < message.content.length; contentIndex++) {
			const content = message.content[contentIndex];
			if ((content.type === "text" && content.text.trim()) || (content.type === "thinking" && content.thinking.trim())) {
				hasVisibleContent = true;
			}
			if (content.type === "toolCall") hasToolCalls = true;
		}

		if (hasVisibleContent) {
			this.contentContainer.addChild(this.acquireStreamingSpacer());
		}

		// Render content in order
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				const text = content.text.trim();
				const slot = i * 2;
				const reusable = reusableMarkdownSlots.get(slot);
				let markdown: Markdown;
				if (reusable && reusable.theme === this.markdownTheme && reusable.transformers === this.markdownTransformers) {
					markdown = reusable.markdown;
					markdown.setText(text);
				} else {
					if (this.allocationMetrics) this.allocationMetrics.markdownInstances++;
					markdown = new Markdown(text, this.outputPad, 0, this.markdownTheme, undefined, {
						transform: createMarkdownTransform("assistant", this.isStreaming, this.markdownTransformers),
						incrementalRenderCache: this.isStreaming && nextMarkdownSlots.size < this.maxStreamingMarkdownSlots,
					});
				}
				if (nextMarkdownSlots.size < this.maxStreamingMarkdownSlots) {
					if (reusable) nextMarkdownSlots.set(slot, reusable);
					else {
						if (this.allocationMetrics) this.allocationMetrics.slotRecordObjects++;
						nextMarkdownSlots.set(slot, {
							markdown,
							theme: this.markdownTheme,
							transformers: this.markdownTransformers,
						});
					}
				}
				this.contentContainer.addChild(markdown);
			} else if (content.type === "thinking") {
				let thinkingText = "";
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					const thinking = thinkingContent.thinking.trim();
					if (thinking) {
						if (thinkingText) thinkingText += "\n\n";
						thinkingText += thinking;
					}
				}
				i--;

				if (!thinkingText) {
					continue;
				}

				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				let hasVisibleContentAfter = false;
				if (this.allocationMetrics) this.allocationMetrics.contentScans++;
				for (let nextIndex = i + 1; nextIndex < message.content.length; nextIndex++) {
					const nextContent = message.content[nextIndex];
					if (
						(nextContent.type === "text" && nextContent.text.trim()) ||
						(nextContent.type === "thinking" && nextContent.thinking.trim())
					) {
						hasVisibleContentAfter = true;
						break;
					}
				}

				if (this.hideThinkingBlock) {
					// Show one static label for each run of thinking blocks when hidden.
					if (this.allocationMetrics) this.allocationMetrics.textInstances++;
					this.contentContainer.addChild(
						new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), this.outputPad, 0),
					);
				} else {
					// Render each run of thinking blocks as one Markdown section.
					const slot = i * 2 + 1;
					const reusable = reusableMarkdownSlots.get(slot);
					let markdown: Markdown;
					if (reusable && reusable.theme === this.markdownTheme && reusable.transformers === this.markdownTransformers) {
						markdown = reusable.markdown;
						markdown.setText(thinkingText);
					} else {
						if (this.allocationMetrics) this.allocationMetrics.markdownInstances++;
						markdown = new Markdown(
							thinkingText,
							this.outputPad,
							0,
							this.markdownTheme,
							{
								color: thinkingTextColor,
								italic: true,
							},
							{
								transform: createMarkdownTransform(
									"assistant-thinking",
									this.isStreaming,
									this.markdownTransformers,
								),
								incrementalRenderCache: this.isStreaming && nextMarkdownSlots.size < this.maxStreamingMarkdownSlots,
							},
						);
					}
					if (nextMarkdownSlots.size < this.maxStreamingMarkdownSlots) {
						if (reusable) nextMarkdownSlots.set(slot, reusable);
						else {
							if (this.allocationMetrics) this.allocationMetrics.slotRecordObjects++;
							nextMarkdownSlots.set(slot, {
								markdown,
								theme: this.markdownTheme,
								transformers: this.markdownTransformers,
							});
						}
					}
					this.contentContainer.addChild(markdown);
				}
				if (hasVisibleContentAfter) {
					this.contentContainer.addChild(this.acquireStreamingSpacer());
				}
			}
		}

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		if (isStreaming) {
			const previousSlots = this.streamingMarkdownSlots;
			this.streamingMarkdownSlots = nextMarkdownSlots;
			this.nextStreamingMarkdownSlots = previousSlots;
			this.nextStreamingMarkdownSlots.clear();
		} else {
			this.streamingMarkdownSlots.clear();
			this.nextStreamingMarkdownSlots.clear();
		}
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			if (this.allocationMetrics) {
				this.allocationMetrics.textInstances++;
			}
			this.contentContainer.addChild(this.acquireStreamingSpacer());
			this.contentContainer.addChild(
				new Text(theme.fg("error", "Response was truncated before completion."), this.outputPad, 0),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				if (this.allocationMetrics) {
					this.allocationMetrics.textInstances++;
				}
				this.contentContainer.addChild(this.acquireStreamingSpacer());
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				if (this.allocationMetrics) {
					this.allocationMetrics.textInstances++;
				}
				this.contentContainer.addChild(this.acquireStreamingSpacer());
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
			}
		}
		this.streamingSpacers.length = this.nextStreamingSpacer;
		if (this.allocationMetrics) this.allocationMetrics.currentSpacers = this.nextStreamingSpacer;
	}

	private acquireStreamingSpacer(): Spacer {
		const index = this.nextStreamingSpacer++;
		let spacer = this.streamingSpacers[index];
		if (!spacer) {
			spacer = new Spacer(1);
			this.streamingSpacers[index] = spacer;
			if (this.allocationMetrics) this.allocationMetrics.spacerInstances++;
		}
		if (this.allocationMetrics && this.nextStreamingSpacer > this.allocationMetrics.spacerHwm) {
			this.allocationMetrics.spacerHwm = this.nextStreamingSpacer;
		}
		return spacer;
	}
}
