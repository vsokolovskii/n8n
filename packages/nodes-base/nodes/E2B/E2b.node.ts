import type {
	CommandResult as E2BCommandResult,
	Sandbox as E2BSandboxInstance,
	SandboxApiOpts,
	SandboxConnectOpts,
	SandboxOpts,
} from 'e2b';
import type * as E2BSDK from 'e2b';
import type {
	ICredentialDataDecryptedObject,
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

type E2BModule = typeof E2BSDK;

type CleanupPolicy = 'auto' | 'keep' | 'kill';

const CLEANUP_POLICIES: CleanupPolicy[] = ['auto', 'keep', 'kill'];

let e2bModule: E2BModule | undefined;

async function loadE2B(): Promise<E2BModule> {
	e2bModule ??= await import('e2b');
	return e2bModule;
}

function isCleanupPolicy(value: unknown): value is CleanupPolicy {
	return typeof value === 'string' && CLEANUP_POLICIES.some((policy) => policy === value);
}

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function getCredentialString(
	credentials: ICredentialDataDecryptedObject,
	key: string,
): string | undefined {
	return asNonEmptyString(credentials[key]);
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function parseStringMapParameter(
	executeFunctions: IExecuteFunctions,
	value: unknown,
	displayName: string,
	itemIndex: number,
): Record<string, string> | undefined {
	if (value === undefined || value === null || value === '') return undefined;

	let parsed = value;
	if (typeof value === 'string') {
		try {
			parsed = JSON.parse(value);
		} catch (error) {
			throw new NodeOperationError(
				executeFunctions.getNode(),
				`${displayName} must be valid JSON: ${getErrorMessage(error)}`,
				{ itemIndex },
			);
		}
	}

	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new NodeOperationError(
			executeFunctions.getNode(),
			`${displayName} must be a JSON object`,
			{
				itemIndex,
			},
		);
	}

	const output: Record<string, string> = {};
	for (const [key, entryValue] of Object.entries(parsed)) {
		if (entryValue === undefined || entryValue === null) continue;
		if (typeof entryValue === 'object') {
			throw new NodeOperationError(
				executeFunctions.getNode(),
				`${displayName} values must be strings, numbers, or booleans`,
				{ itemIndex },
			);
		}
		output[key] = String(entryValue);
	}

	return Object.keys(output).length > 0 ? output : undefined;
}

function getNodeParameterWithLegacy(
	executeFunctions: IExecuteFunctions,
	name: string,
	legacyName: string,
	itemIndex: number,
	fallback: unknown,
): unknown {
	const value = getNodeParameterOrFallback(executeFunctions, name, itemIndex, undefined);
	if (value !== undefined) return value;
	return getNodeParameterOrFallback(executeFunctions, legacyName, itemIndex, fallback);
}

function getNodeParameterOrFallback(
	executeFunctions: IExecuteFunctions,
	name: string,
	itemIndex: number,
	fallback: unknown,
): unknown {
	try {
		return executeFunctions.getNodeParameter(name, itemIndex, fallback);
	} catch (error) {
		if (error instanceof Error && error.message === `Could not get parameter "${name}"`) {
			return fallback;
		}
		throw error;
	}
}

function getTimeoutMs(executeFunctions: IExecuteFunctions, itemIndex: number): number {
	const timeoutSeconds = Number(
		getNodeParameterWithLegacy(
			executeFunctions,
			'options.timeoutSeconds',
			'timeoutSeconds',
			itemIndex,
			300,
		),
	);

	if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
		throw new NodeOperationError(executeFunctions.getNode(), 'Timeout must be greater than 0', {
			itemIndex,
		});
	}

	return Math.round(timeoutSeconds * 1000);
}

function getRequiredStringParameter(
	executeFunctions: IExecuteFunctions,
	name: string,
	displayName: string,
	itemIndex: number,
): string {
	const value = asNonEmptyString(executeFunctions.getNodeParameter(name, itemIndex));
	if (!value) {
		throw new NodeOperationError(executeFunctions.getNode(), `${displayName} is required`, {
			itemIndex,
		});
	}
	return value;
}

function getCleanupPolicy(executeFunctions: IExecuteFunctions, itemIndex: number): CleanupPolicy {
	const rawPolicy = getNodeParameterOrFallback(
		executeFunctions,
		'options.cleanupPolicy',
		itemIndex,
		undefined,
	);
	if (rawPolicy === undefined) {
		const legacyKillAfterRun = getNodeParameterOrFallback(
			executeFunctions,
			'killAfterRun',
			itemIndex,
			undefined,
		);
		if (typeof legacyKillAfterRun === 'boolean') return legacyKillAfterRun ? 'kill' : 'keep';
		return 'auto';
	}

	if (!isCleanupPolicy(rawPolicy)) {
		throw new NodeOperationError(executeFunctions.getNode(), 'Cleanup must be auto, keep, or kill', {
			itemIndex,
		});
	}

	return rawPolicy;
}

function shouldKillSandbox(cleanupPolicy: CleanupPolicy, createdSandbox: boolean): boolean {
	if (cleanupPolicy === 'kill') return true;
	if (cleanupPolicy === 'keep') return false;
	return createdSandbox;
}

function buildBaseConnectionOpts(
	credentials: ICredentialDataDecryptedObject,
	timeoutMs: number,
): SandboxOpts {
	const apiKey = getCredentialString(credentials, 'apiKey');
	const apiUrl = getCredentialString(credentials, 'apiUrl');
	const domain = getCredentialString(credentials, 'domain');
	const sandboxUrl = getCredentialString(credentials, 'sandboxUrl');

	return {
		...(apiKey ? { apiKey } : {}),
		...(apiUrl ? { apiUrl } : {}),
		...(domain ? { domain } : {}),
		...(sandboxUrl ? { sandboxUrl } : {}),
		requestTimeoutMs: timeoutMs,
	};
}

function buildApiOpts(
	credentials: ICredentialDataDecryptedObject,
	timeoutMs: number,
): SandboxApiOpts {
	const apiKey = getCredentialString(credentials, 'apiKey');
	const domain = getCredentialString(credentials, 'domain');

	return {
		...(apiKey ? { apiKey } : {}),
		...(domain ? { domain } : {}),
		requestTimeoutMs: timeoutMs,
	};
}

function buildConnectOpts(
	credentials: ICredentialDataDecryptedObject,
	timeoutMs: number,
): SandboxConnectOpts {
	return {
		...buildBaseConnectionOpts(credentials, timeoutMs),
		timeoutMs,
	};
}

function getCreateOpts(
	executeFunctions: IExecuteFunctions,
	credentials: ICredentialDataDecryptedObject,
	itemIndex: number,
): SandboxOpts {
	const timeoutMs = getTimeoutMs(executeFunctions, itemIndex);
	const template = asNonEmptyString(
		getNodeParameterWithLegacy(
			executeFunctions,
			'options.template',
			'template',
			itemIndex,
			'',
		),
	);
	const metadata = parseStringMapParameter(
		executeFunctions,
		getNodeParameterWithLegacy(
			executeFunctions,
			'options.metadataJson',
			'metadataJson',
			itemIndex,
			'',
		),
		'Metadata',
		itemIndex,
	);
	const envs = parseStringMapParameter(
		executeFunctions,
		getNodeParameterWithLegacy(executeFunctions, 'options.envJson', 'envJson', itemIndex, ''),
		'Environment variables',
		itemIndex,
	);
	const allowInternetAccess =
		getNodeParameterWithLegacy(
			executeFunctions,
			'options.allowInternetAccess',
			'allowInternetAccess',
			itemIndex,
			true,
		) === true;

	return {
		...buildBaseConnectionOpts(credentials, timeoutMs),
		...(template ? { template } : {}),
		...(metadata ? { metadata } : {}),
		...(envs ? { envs } : {}),
		allowInternetAccess,
		timeoutMs,
	};
}

function toCommandResultData(
	result: E2BCommandResult,
	sandbox: E2BSandboxInstance,
	command: string,
	startedAt: number,
	createdSandbox: boolean,
	killedAfterRun: boolean,
): IDataObject {
	return {
		sandboxId: sandbox.sandboxId,
		sandboxDomain: sandbox.sandboxDomain,
		createdSandbox,
		killedAfterRun,
		command,
		success: result.exitCode === 0,
		exitCode: result.exitCode,
		stdout: result.stdout,
		stderr: result.stderr,
		executionTimeMs: Date.now() - startedAt,
	};
}

export class E2b implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'E2B',
		name: 'e2b',
		icon: {
			light: 'file:e2b.svg',
			dark: 'file:e2b.dark.svg',
		},
		group: ['transform'],
		version: 1,
		subtitle: '={{ $parameter["sandboxId"] ? "Existing sandbox" : "New sandbox" }}',
		description: 'Run a command in an E2B sandbox',
		defaults: {
			name: 'E2B',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'e2bApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Sandbox ID',
				name: 'sandboxId',
				type: 'string',
				default: '',
				description:
					'Optional sandbox to run the command in. Leave empty to create a sandbox for this execution.',
			},
			{
				displayName: 'Command',
				name: 'command',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'python -c "print(1 + 1)"',
				typeOptions: {
					rows: 4,
				},
			},
			{
				displayName: 'Working Directory',
				name: 'cwd',
				type: 'string',
				default: '',
				description: 'Directory where the command runs',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				options: [
					{
						displayName: 'Template or Snapshot ID',
						name: 'template',
						type: 'string',
						default: '',
						description:
							'E2B template or snapshot to use when this node creates a sandbox. Leave empty to use the default E2B template.',
					},
					{
						displayName: 'Metadata',
						name: 'metadataJson',
						type: 'json',
						default: '{}',
						description: 'Metadata to attach when this node creates a sandbox',
					},
					{
						displayName: 'Environment Variables',
						name: 'envJson',
						type: 'json',
						default: '{}',
						description: 'Environment variables to set for the sandbox and command',
					},
					{
						displayName: 'Allow Internet Access',
						name: 'allowInternetAccess',
						type: 'boolean',
						default: true,
						description: 'Whether the sandbox can access the internet',
					},
					{
						displayName: 'Cleanup',
						name: 'cleanupPolicy',
						type: 'options',
						noDataExpression: true,
						options: [
							{
								name: 'Auto',
								value: 'auto',
								description: 'Kill sandboxes created by this node and keep existing sandboxes',
							},
							{
								name: 'Keep Sandbox',
								value: 'keep',
								description: 'Keep the sandbox running after the command finishes',
							},
							{
								name: 'Kill Sandbox',
								value: 'kill',
								description: 'Kill the sandbox after the command finishes',
							},
						],
						default: 'auto',
					},
					{
						displayName: 'Timeout',
						name: 'timeoutSeconds',
						type: 'number',
						typeOptions: {
							minValue: 1,
						},
						default: 300,
						description: 'Timeout in seconds for the E2B operation',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const credentials = await this.getCredentials('e2bApi');
		const returnData: INodeExecutionData[] = [];
		const { Sandbox, CommandExitError } = await loadE2B();

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const timeoutMs = getTimeoutMs(this, itemIndex);
				const sandboxId = asNonEmptyString(this.getNodeParameter('sandboxId', itemIndex, ''));
				const command = getRequiredStringParameter(this, 'command', 'Command', itemIndex);
				const cwd = asNonEmptyString(this.getNodeParameter('cwd', itemIndex, ''));
				const cleanupPolicy = getCleanupPolicy(this, itemIndex);
				const envs = parseStringMapParameter(
					this,
					getNodeParameterWithLegacy(this, 'options.envJson', 'envJson', itemIndex, ''),
					'Environment variables',
					itemIndex,
				);
				const createdSandbox = !sandboxId;
				const killAfterRun = shouldKillSandbox(cleanupPolicy, createdSandbox);
				const sandbox = sandboxId
					? await Sandbox.connect(sandboxId, buildConnectOpts(credentials, timeoutMs))
					: await Sandbox.create(getCreateOpts(this, credentials, itemIndex));

				let resultData: IDataObject | undefined;
				let executionError: unknown;
				let cleanupError: unknown;
				try {
					const startedAt = Date.now();
					let result: E2BCommandResult;
					try {
						result = await sandbox.commands.run(command, {
							...(cwd ? { cwd } : {}),
							...(envs ? { envs } : {}),
							timeoutMs,
							requestTimeoutMs: timeoutMs,
						});
					} catch (error) {
						if (error instanceof CommandExitError) {
							result = error;
						} else {
							throw error;
						}
					}

					resultData = toCommandResultData(
						result,
						sandbox,
						command,
						startedAt,
						createdSandbox,
						false,
					);
				} catch (error) {
					executionError = error;
				} finally {
					if (killAfterRun) {
						try {
							await sandbox.kill(buildApiOpts(credentials, timeoutMs));
							if (resultData) resultData.killedAfterRun = true;
						} catch (error) {
							cleanupError = error;
							if (resultData) resultData.cleanupError = getErrorMessage(error);
						}
					}
				}

				if (executionError) {
					if (cleanupError) {
						throw new NodeOperationError(
							this.getNode(),
							`E2B command failed, and sandbox cleanup also failed: ${getErrorMessage(executionError)}; cleanup error: ${getErrorMessage(cleanupError)}`,
							{ itemIndex },
						);
					}
					if (executionError instanceof Error) throw executionError;
					throw new NodeOperationError(this.getNode(), getErrorMessage(executionError), {
						itemIndex,
					});
				}

				if (cleanupError) {
					throw new NodeOperationError(
						this.getNode(),
						`Sandbox cleanup failed after the E2B command finished: ${getErrorMessage(cleanupError)}`,
						{ itemIndex },
					);
				}

				if (resultData) {
					returnData.push({
						json: resultData,
						pairedItem: { item: itemIndex },
					});
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: {
							error: getErrorMessage(error),
						},
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
}
