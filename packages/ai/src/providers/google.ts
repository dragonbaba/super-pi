import { googleGenerativeAIApi } from "../api/google-generative-ai.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { GOOGLE_MODELS } from "./google.models.ts";
import { profileGoogleModel } from "./google-profile.ts";

const PROFILED_GOOGLE_MODELS = Object.values(GOOGLE_MODELS).map(profileGoogleModel);

export function googleProvider(): Provider<"google-generative-ai"> {
	return createProvider({
		id: "google",
		name: "Google",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		auth: { apiKey: envApiKeyAuth("Gemini API key", ["GEMINI_API_KEY"]) },
		models: PROFILED_GOOGLE_MODELS,
		api: googleGenerativeAIApi(),
	});
}
