export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.SP_EXPERIMENTAL === "1";
}
