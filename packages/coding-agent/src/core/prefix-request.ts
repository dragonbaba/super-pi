import type { AssistantMessage, EffectiveDispatchObservation, Model } from "@super-pi/ai";
import type { AgentSession } from "./agent-session.ts";
import { buildPrefixManifest, type PrefixManifestBuildInput, type PrefixManifestRecorder } from "./prefix-manifest.ts";

/** One logical main request. No per-delta callback, message wrapper or completion Promise. */
export class PrefixRequestObservation {
	private recorder: PrefixManifestRecorder | undefined;
	private readonly sequence: number;
	private readonly contextGeneration: number;
	private readonly credentialGeneration: number;
	private readonly provider: string;
	private session: AgentSession | undefined;
	private input: PrefixManifestBuildInput | undefined;
	private signal: AbortSignal | undefined;

	constructor(recorder: PrefixManifestRecorder, owner: object, session: AgentSession,
		input: PrefixManifestBuildInput, signal: AbortSignal | undefined) {
		this.recorder = recorder;
		this.session = session;
		this.input = input;
		this.signal = signal;
		this.provider = input.provider;
		this.contextGeneration = session.sessionManager.getContextGeneration();
		this.credentialGeneration = session.modelRuntime.getCredentialGeneration(input.provider);
		this.sequence = recorder.beginRequest(owner, this, this.contextGeneration, this.credentialGeneration, input.provider);
		try { recorder.recordIntent(buildPrefixManifest(input)); } catch { /* Diagnostics cannot block dispatch. */ }
		if (signal?.aborted) this.handleEvent();
		else signal?.addEventListener("abort", this, { once: true });
	}

	isCurrent(): boolean {
		const session = this.session;
		return session !== undefined && !this.signal?.aborted && this.recorder?.isCurrentRequest(this.sequence) === true &&
			session.sessionManager.getContextGeneration() === this.contextGeneration &&
			session.modelRuntime.getCredentialGeneration(this.provider) === this.credentialGeneration;
	}

	record(observation: Readonly<EffectiveDispatchObservation>, model: Model<any>): void {
		if (!this.isCurrent() || !this.input) return;
		try {
			this.recorder?.recordRequest(this.sequence, buildPrefixManifest({ ...this.input,
				provider: model.provider, model: model.id, api: model.api, effectiveDispatch: observation }));
		} catch { /* Diagnostics cannot block dispatch. */ }
	}

	onResult(message: AssistantMessage | undefined): void {
		try { this.recorder?.finishRequest(this.sequence, this.isCurrent() ? message : undefined); }
		finally { this.release(); }
	}

	handleEvent(): void { this.onResult(undefined); }

	release(): void {
		this.signal?.removeEventListener("abort", this);
		this.signal = undefined;
		this.input = undefined;
		this.session = undefined;
		this.recorder = undefined;
	}
}
