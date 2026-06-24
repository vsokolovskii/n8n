import type {
	CommandResult as E2BCommandResult,
	Sandbox as E2BSandboxInstance,
	SandboxApiOpts,
	SandboxConnectOpts,
	SandboxInfo as E2BSandboxInfo,
	SandboxOpts,
	SnapshotInfo as E2BSnapshotInfo,
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

type Operation =
	| 'create'
	| 'createSnapshot'
	| 'deleteSnapshot'
	| 'get'
	| 'kill'
	| 'list'
	| 'listSnapshots'
	| 'pause'
	| 'runCommand';

const OPERATIONS: Operation[] = [
	'create',
	'createSnapshot',
	'deleteSnapshot',
	'get',
	'kill',
	'list',
	'listSnapshots',
	'pause',
	'runCommand',
];

let e2bModule: E2BModule | undefined;

async function loadE2B(): Promise<E2BModule> {
	e2bModule ??= await import('e2b');
	return e2bModule;
}

function isOperation(value: unknown): value is Operation {
	return typeof value === 'string' && OPERATIONS.some((operation) => operation === value);
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

function getTimeoutMs(executeFunctions: IExecuteFunctions, itemIndex: number): number {
	const timeoutSeconds = Number(
		executeFunctions.getNodeParameter('timeoutSeconds', itemIndex, 300),
	);

	if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
		throw new NodeOperationError(executeFunctions.getNode(), 'Timeout must be greater than 0', {
			itemIndex,
		});
	}

	return Math.round(timeoutSeconds * 1000);
}

function getLimit(executeFunctions: IExecuteFunctions, itemIndex: number): number {
	const limit = Number(executeFunctions.getNodeParameter('limit', itemIndex, 50));

	if (!Number.isInteger(limit) || limit <= 0) {
		throw new NodeOperationError(executeFunctions.getNode(), 'Limit must be a positive integer', {
			itemIndex,
		});
	}

	return limit;
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
	const template = asNonEmptyString(executeFunctions.getNodeParameter('template', itemIndex, ''));
	const metadata = parseStringMapParameter(
		executeFunctions,
		executeFunctions.getNodeParameter('metadataJson', itemIndex, ''),
		'Metadata',
		itemIndex,
	);
	const envs = parseStringMapParameter(
		executeFunctions,
		executeFunctions.getNodeParameter('envJson', itemIndex, ''),
		'Environment Variables',
		itemIndex,
	);
	const allowInternetAccess =
		executeFunctions.getNodeParameter('allowInternetAccess', itemIndex, true) === true;

	return {
		...buildBaseConnectionOpts(credentials, timeoutMs),
		...(template ? { template } : {}),
		...(metadata ? { metadata } : {}),
		...(envs ? { envs } : {}),
		allowInternetAccess,
		timeoutMs,
	};
}

function toIsoString(value: Date | string | undefined): string | undefined {
	if (value instanceof Date) return value.toISOString();
	return value;
}

function toSandboxInfoData(info: E2BSandboxInfo, sandboxDomain?: string): IDataObject {
	return {
		sandboxId: info.sandboxId,
		templateId: info.templateId,
		name: info.name,
		state: info.state,
		metadata: info.metadata ?? {},
		startedAt: toIsoString(info.startedAt),
		endAt: toIsoString(info.endAt),
		cpuCount: info.cpuCount,
		memoryMB: info.memoryMB,
		envdVersion: info.envdVersion,
		allowInternetAccess: info.allowInternetAccess,
		sandboxDomain: sandboxDomain ?? info.sandboxDomain,
	};
}

function toSnapshotInfoData(info: E2BSnapshotInfo): IDataObject {
	return {
		snapshotId: info.snapshotId,
		names: info.names,
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
		subtitle: '={{ $parameter["operation"] }}',
		description: 'Run commands and manage E2B sandboxes',
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
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Create Sandbox',
						value: 'create',
						action: 'Create a sandbox',
					},
					{
						name: 'Create Snapshot',
						value: 'createSnapshot',
						action: 'Create a snapshot',
					},
					{
						name: 'Delete Snapshot',
						value: 'deleteSnapshot',
						action: 'Delete a snapshot',
					},
					{
						name: 'Get Sandbox',
						value: 'get',
						action: 'Get a sandbox',
					},
					{
						name: 'Kill Sandbox',
						value: 'kill',
						action: 'Kill a sandbox',
					},
					{
						name: 'List Sandboxes',
						value: 'list',
						action: 'List sandboxes',
					},
					{
						name: 'List Snapshots',
						value: 'listSnapshots',
						action: 'List snapshots',
					},
					{
						name: 'Pause Sandbox',
						value: 'pause',
						action: 'Pause a sandbox',
					},
					{
						name: 'Run Command',
						value: 'runCommand',
						action: 'Run a command in a sandbox',
					},
				],
				default: 'runCommand',
			},
			{
				displayName: 'Sandbox ID',
				name: 'sandboxId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						operation: ['createSnapshot', 'get', 'kill', 'pause'],
					},
				},
			},
			{
				displayName: 'Snapshot ID',
				name: 'snapshotId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						operation: ['deleteSnapshot'],
					},
				},
			},
			{
				displayName: 'Sandbox ID',
				name: 'sandboxId',
				type: 'string',
				default: '',
				description: 'Existing sandbox ID. Leave empty to create a sandbox for this command.',
				displayOptions: {
					show: {
						operation: ['runCommand'],
					},
				},
			},
			{
				displayName: 'Sandbox ID',
				name: 'sandboxId',
				type: 'string',
				default: '',
				description: 'Optional source sandbox ID to filter snapshots by',
				displayOptions: {
					show: {
						operation: ['listSnapshots'],
					},
				},
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
				displayOptions: {
					show: {
						operation: ['runCommand'],
					},
				},
			},
			{
				displayName: 'Working Directory',
				name: 'cwd',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						operation: ['runCommand'],
					},
				},
			},
			{
				displayName: 'Template or Snapshot ID',
				name: 'template',
				type: 'string',
				default: '',
				description:
					'E2B template name/ID or snapshot ID. Leave empty to use the default E2B sandbox template.',
				displayOptions: {
					show: {
						operation: ['create', 'runCommand'],
					},
				},
			},
			{
				displayName: 'Snapshot Name',
				name: 'snapshotName',
				type: 'string',
				default: '',
				description: 'Optional name for the snapshot template',
				displayOptions: {
					show: {
						operation: ['createSnapshot'],
					},
				},
			},
			{
				displayName: 'Metadata',
				name: 'metadataJson',
				type: 'json',
				default: '{}',
				description: 'Metadata to attach when creating a sandbox',
				displayOptions: {
					show: {
						operation: ['create', 'runCommand'],
					},
				},
			},
			{
				displayName: 'Environment Variables',
				name: 'envJson',
				type: 'json',
				default: '{}',
				description: 'Environment variables to set for the sandbox or command',
				displayOptions: {
					show: {
						operation: ['create', 'runCommand'],
					},
				},
			},
			{
				displayName: 'Allow Internet Access',
				name: 'allowInternetAccess',
				type: 'boolean',
				default: true,
				displayOptions: {
					show: {
						operation: ['create', 'runCommand'],
					},
				},
			},
			{
				displayName: 'Kill Sandbox After Run',
				name: 'killAfterRun',
				type: 'boolean',
				default: false,
				description: 'Whether to kill the sandbox after running the command',
				displayOptions: {
					show: {
						operation: ['runCommand'],
					},
				},
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				typeOptions: {
					minValue: 1,
				},
				default: 50,
				description: 'Max number of results to return',
				displayOptions: {
					show: {
						operation: ['list', 'listSnapshots'],
					},
				},
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
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const credentials = await this.getCredentials('e2bApi');
		const returnData: INodeExecutionData[] = [];
		const { Sandbox, CommandExitError } = await loadE2B();

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const rawOperation = this.getNodeParameter('operation', itemIndex);
				if (!isOperation(rawOperation)) {
					throw new NodeOperationError(
						this.getNode(),
						`The operation "${rawOperation}" is not known`,
						{
							itemIndex,
						},
					);
				}

				const timeoutMs = getTimeoutMs(this, itemIndex);

				if (rawOperation === 'create') {
					const sandbox = await Sandbox.create(getCreateOpts(this, credentials, itemIndex));
					const info = await sandbox.getInfo(buildApiOpts(credentials, timeoutMs));
					returnData.push({
						json: toSandboxInfoData(info, sandbox.sandboxDomain),
						pairedItem: { item: itemIndex },
					});
					continue;
				}

				if (rawOperation === 'list') {
					const paginator = Sandbox.list({
						...buildApiOpts(credentials, timeoutMs),
						limit: getLimit(this, itemIndex),
					});
					const sandboxes = await paginator.nextItems();
					for (const sandbox of sandboxes) {
						returnData.push({
							json: toSandboxInfoData(sandbox),
							pairedItem: { item: itemIndex },
						});
					}
					continue;
				}

				if (rawOperation === 'createSnapshot') {
					const sandboxId = getRequiredStringParameter(this, 'sandboxId', 'Sandbox ID', itemIndex);
					const snapshotName = asNonEmptyString(
						this.getNodeParameter('snapshotName', itemIndex, ''),
					);
					const snapshot = await Sandbox.createSnapshot(sandboxId, {
						...buildApiOpts(credentials, timeoutMs),
						...(snapshotName ? { name: snapshotName } : {}),
					});
					returnData.push({
						json: toSnapshotInfoData(snapshot),
						pairedItem: { item: itemIndex },
					});
					continue;
				}

				if (rawOperation === 'listSnapshots') {
					const sandboxId = asNonEmptyString(this.getNodeParameter('sandboxId', itemIndex, ''));
					const paginator = Sandbox.listSnapshots({
						...buildApiOpts(credentials, timeoutMs),
						...(sandboxId ? { sandboxId } : {}),
						limit: getLimit(this, itemIndex),
					});
					const snapshots = await paginator.nextItems();
					for (const snapshot of snapshots) {
						returnData.push({
							json: toSnapshotInfoData(snapshot),
							pairedItem: { item: itemIndex },
						});
					}
					continue;
				}

				if (rawOperation === 'deleteSnapshot') {
					const snapshotId = getRequiredStringParameter(
						this,
						'snapshotId',
						'Snapshot ID',
						itemIndex,
					);
					const deleted = await Sandbox.deleteSnapshot(snapshotId, buildApiOpts(credentials, timeoutMs));
					returnData.push({
						json: {
							snapshotId,
							deleted,
						},
						pairedItem: { item: itemIndex },
					});
					continue;
				}

				if (rawOperation === 'get') {
					const sandboxId = getRequiredStringParameter(this, 'sandboxId', 'Sandbox ID', itemIndex);
					const info = await Sandbox.getInfo(sandboxId, buildApiOpts(credentials, timeoutMs));
					returnData.push({
						json: toSandboxInfoData(info),
						pairedItem: { item: itemIndex },
					});
					continue;
				}

				if (rawOperation === 'pause') {
					const sandboxId = getRequiredStringParameter(this, 'sandboxId', 'Sandbox ID', itemIndex);
					await Sandbox.pause(sandboxId, buildApiOpts(credentials, timeoutMs));
					returnData.push({
						json: {
							sandboxId,
							paused: true,
						},
						pairedItem: { item: itemIndex },
					});
					continue;
				}

				if (rawOperation === 'kill') {
					const sandboxId = getRequiredStringParameter(this, 'sandboxId', 'Sandbox ID', itemIndex);
					await Sandbox.kill(sandboxId, buildApiOpts(credentials, timeoutMs));
					returnData.push({
						json: {
							sandboxId,
							killed: true,
						},
						pairedItem: { item: itemIndex },
					});
					continue;
				}

				const sandboxId = asNonEmptyString(this.getNodeParameter('sandboxId', itemIndex, ''));
				const command = getRequiredStringParameter(this, 'command', 'Command', itemIndex);
				const cwd = asNonEmptyString(this.getNodeParameter('cwd', itemIndex, ''));
				const killAfterRun = this.getNodeParameter('killAfterRun', itemIndex, false) === true;
				const envs = parseStringMapParameter(
					this,
					this.getNodeParameter('envJson', itemIndex, ''),
					'Environment Variables',
					itemIndex,
				);
				const createdSandbox = !sandboxId;
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
							`E2B command failed and the sandbox could not be killed: ${getErrorMessage(executionError)}; cleanup error: ${getErrorMessage(cleanupError)}`,
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
						`E2B command succeeded but the sandbox could not be killed: ${getErrorMessage(cleanupError)}`,
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
