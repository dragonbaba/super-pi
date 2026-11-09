#!/usr/bin/env node
/**
 * CLI entry point. Standalone version queries only need package metadata.
 * All other invocations retain main.ts parsing and startup behavior.
 */
import * as nodeModule from "node:module";
import { isStandaloneVersionQuery } from "./cli/version-query.ts";
import { APP_NAME, VERSION } from "./config.ts";

process.title = APP_NAME;
process.env.SP_CODING_AGENT = "true";
process.env.AI_AGENT = "superpi";
process.emitWarning = (() => {}) as typeof process.emitWarning;

const args = process.argv.slice(2);
if (isStandaloneVersionQuery(args)) {
	console.log(VERSION);
	process.exit(0);
} else {
	// Reuse V8 code caches for the main module graph on later starts. Node
	// reports an unusable or disabled cache directory as a status, never a throw;
	// runtimes without the API skip it.
	nodeModule.enableCompileCache?.();
	// Configure undici before loading main and before provider SDKs issue requests.
	// Runtime settings are applied after SettingsManager loads global/project settings.
	const { configureHttpDispatcher } = await import("./core/http-dispatcher.ts");
	configureHttpDispatcher();
	const { main } = await import("./main.ts");
	main(args);
}
