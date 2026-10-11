import type { Api, Model, StreamOptions } from "../types.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";

export interface AzureEndpointOptions extends StreamOptions {
	azureApiVersion?: string;
	azureResourceName?: string;
	azureBaseUrl?: string;
	azureDeploymentName?: string;
}

function parseDeploymentNameMap(value: string | undefined): Map<string, string> {
	const map = new Map<string, string>();
	if (!value) return map;
	for (const entry of value.split(",")) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		const [modelId, deploymentName] = trimmed.split("=", 2);
		if (!modelId || !deploymentName) continue;
		map.set(modelId.trim(), deploymentName.trim());
	}
	return map;
}

export function resolveDeploymentName(model: Pick<Model<Api>, "id">, options?: AzureEndpointOptions): string {
	if (options?.azureDeploymentName) return options.azureDeploymentName;
	const mappedDeployment = parseDeploymentNameMap(
		getProviderEnvValue("AZURE_OPENAI_DEPLOYMENT_NAME_MAP", options?.env),
	).get(model.id);
	return mappedDeployment || model.id;
}

function normalizeAzureBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error(`Invalid Azure OpenAI base URL: ${baseUrl}`);
	}
	const isAzureHost =
		url.hostname.endsWith(".openai.azure.com") ||
		url.hostname.endsWith(".cognitiveservices.azure.com") ||
		url.hostname.endsWith(".ai.azure.com");
	const normalizedPath = url.pathname.replace(/\/+$/, "");
	// SDKs append their own operation paths; preserve custom proxy base paths.
	if (isAzureHost && (
		normalizedPath === "" || normalizedPath === "/" || normalizedPath === "/openai" ||
		normalizedPath === "/openai/v1/responses" || normalizedPath === "/openai/v1/chat/completions"
	)) {
		url.pathname = "/openai/v1";
		url.search = "";
	}
	return url.toString().replace(/\/+$/, "");
}

export function resolveAzureBaseUrl(model: Pick<Model<Api>, "baseUrl">, options?: AzureEndpointOptions): string {
	const baseUrl = options?.azureBaseUrl?.trim() || getProviderEnvValue("AZURE_OPENAI_BASE_URL", options?.env)?.trim();
	const resourceName = options?.azureResourceName || getProviderEnvValue("AZURE_OPENAI_RESOURCE_NAME", options?.env);
	const resolved = baseUrl || (resourceName ? `https://${resourceName}.openai.azure.com/openai/v1` : model.baseUrl);
	if (!resolved) {
		throw new Error(
			"Azure OpenAI base URL is required. Set AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME, or pass azureBaseUrl, azureResourceName, or model.baseUrl.",
		);
	}
	return normalizeAzureBaseUrl(resolved);
}

export function resolveAzureConfig(model: Pick<Model<Api>, "baseUrl">, options?: AzureEndpointOptions) {
	return {
		baseUrl: resolveAzureBaseUrl(model, options),
		apiVersion: options?.azureApiVersion || getProviderEnvValue("AZURE_OPENAI_API_VERSION", options?.env) || "v1",
	};
}
