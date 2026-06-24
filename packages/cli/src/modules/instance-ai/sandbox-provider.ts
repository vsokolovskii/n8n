import type { InstanceAiSandboxProvider } from '@n8n/api-types';
import { normalizeSandboxProvider as normalizeRuntimeSandboxProvider } from '@n8n/agents/sandbox';
import { OperationalError } from 'n8n-workflow';

/** Coerce a raw config/env value to a supported provider, falling back to the default. */
export function normalizeSandboxProvider(value: string | undefined): InstanceAiSandboxProvider {
	return normalizeRuntimeSandboxProvider(value);
}

export const N8N_SANDBOX_SERVICE_URL_REQUIRED_MESSAGE =
	'N8N_SANDBOX_SERVICE_URL is required when Instance AI sandbox provider is n8n-sandbox.';

export const E2B_API_KEY_REQUIRED_MESSAGE =
	'E2B_API_KEY is required when Instance AI sandbox provider is e2b.';

/** Require a non-empty n8n sandbox service URL, raising a clear operator-facing error otherwise. */
export function requireN8nSandboxServiceUrl(value: string): string {
	const serviceUrl = value.trim();
	if (serviceUrl.length === 0) {
		throw new OperationalError(N8N_SANDBOX_SERVICE_URL_REQUIRED_MESSAGE);
	}
	return serviceUrl;
}

/** Require a non-empty E2B API key, raising a clear operator-facing error otherwise. */
export function requireE2BApiKey(value: string): string {
	const apiKey = value.trim();
	if (apiKey.length === 0) {
		throw new OperationalError(E2B_API_KEY_REQUIRED_MESSAGE);
	}
	return apiKey;
}
