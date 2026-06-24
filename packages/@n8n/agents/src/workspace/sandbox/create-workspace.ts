import { DaytonaSandbox } from './daytona-sandbox';
import { E2BSandbox } from './e2b-sandbox';
import { N8nSandboxServiceSandbox } from './n8n-sandbox-sandbox';
import type {
	CreateSandboxOptions,
	SandboxConfig,
	SandboxFilesystem,
	SandboxInstance,
} from './types';
import { DaytonaFilesystem } from '../filesystem/daytona-filesystem';
import { E2BFilesystem } from '../filesystem/e2b-filesystem';
import { N8nSandboxFilesystem } from '../filesystem/n8n-sandbox-filesystem';

export async function createSandbox(
	config: SandboxConfig,
	options: CreateSandboxOptions = {},
): Promise<SandboxInstance | undefined> {
	return await Promise.resolve(buildSandbox(config, options));
}

function buildSandbox(
	config: SandboxConfig,
	options: CreateSandboxOptions = {},
): SandboxInstance | undefined {
	if (!config.enabled) return undefined;

	const provider = config.provider;

	if (provider === 'daytona') {
		const mode = config.getAuthToken ? 'proxy' : 'direct';
		const logger = options.logger ?? config.logger;
		return new DaytonaSandbox({
			id: config.id,
			name: config.name,
			apiKey: config.getAuthToken ? undefined : config.daytonaApiKey,
			getAuthToken: config.getAuthToken,
			refreshSkewMs: config.refreshSkewMs,
			logger,
			apiUrl: config.daytonaApiUrl,
			labels: config.labels,
			...(config.ephemeral !== undefined ? { ephemeral: config.ephemeral } : {}),
			...(config.autoStopInterval !== undefined
				? { autoStopInterval: config.autoStopInterval }
				: {}),
			...(config.autoArchiveInterval !== undefined
				? { autoArchiveInterval: config.autoArchiveInterval }
				: {}),
			...(config.autoDeleteInterval !== undefined
				? { autoDeleteInterval: config.autoDeleteInterval }
				: {}),
			...(config.image ? { image: config.image } : {}),
			...(config.snapshot ? { snapshot: config.snapshot } : {}),
			language: 'typescript',
			timeout: config.timeout ?? 300_000,
			createTimeoutSeconds: config.createTimeoutSeconds ?? 300,
			errorReporter: options.errorReporter,
			createStrategyMode: mode,
		});
	}

	if (provider === 'n8n-sandbox') {
		return new N8nSandboxServiceSandbox({
			apiKey: config.apiKey,
			serviceUrl: config.serviceUrl,
			timeout: config.timeout ?? 300_000,
		});
	}

	if (provider === 'e2b') {
		return new E2BSandbox({
			id: config.id,
			apiKey: config.apiKey,
			apiUrl: config.apiUrl,
			domain: config.domain,
			sandboxUrl: config.sandboxUrl,
			template: config.template,
			timeout: config.timeout ?? 300_000,
			requestTimeoutMs: config.requestTimeoutMs,
			metadata: config.metadata,
			env: config.env,
			secure: config.secure,
			allowInternetAccess: config.allowInternetAccess,
			network: config.network,
			lifecycle: config.lifecycle,
		});
	}

	const exhaustiveProvider: never = provider;
	throw new Error(`Unsupported sandbox provider: ${String(exhaustiveProvider)}`);
}

export function createFilesystem(sandbox: undefined): undefined;
export function createFilesystem(sandbox: SandboxInstance): SandboxFilesystem;
export function createFilesystem(
	sandbox: SandboxInstance | undefined,
): SandboxFilesystem | undefined {
	if (!sandbox) return undefined;

	if (sandbox instanceof N8nSandboxServiceSandbox) {
		return new N8nSandboxFilesystem(sandbox);
	}

	if (sandbox instanceof DaytonaSandbox) {
		return new DaytonaFilesystem(sandbox);
	}

	if (sandbox instanceof E2BSandbox) {
		return new E2BFilesystem(sandbox);
	}

	throw new Error(`Unsupported sandbox instance: ${sandbox.name}`);
}
