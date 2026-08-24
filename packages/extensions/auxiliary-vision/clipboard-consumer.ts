import {
	uninstallClipboardArtifactLifecycle,
	type ClipboardArtifactLifecycle,
	type MaterializedClipboardArtifact,
} from "./clipboard-lifecycle.ts";

/**
 * Bridges auxiliary materialization to the creator-owned lease. Staging never
 * deletes: only an accepted user message or a completed explicit inspect call
 * confirms that image bytes have a durable downstream consumer.
 */
export class ClipboardConsumptionController {
	private readonly lifecycle: ClipboardArtifactLifecycle;

	constructor(lifecycle: ClipboardArtifactLifecycle) {
		this.lifecycle = lifecycle;
	}

	stage(artifacts: readonly MaterializedClipboardArtifact[]): void {
		this.lifecycle.materialized(artifacts);
	}

	confirmAcceptedUserMessage(role: string): void {
		if (role === "user") this.lifecycle.confirmMaterialized();
	}

	confirmExplicitInspection(): void {
		this.lifecycle.confirmMaterialized();
	}

	shutdown(): void {
		uninstallClipboardArtifactLifecycle(this.lifecycle);
	}
}
