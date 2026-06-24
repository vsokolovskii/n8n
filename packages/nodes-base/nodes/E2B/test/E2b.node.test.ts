import type { IExecuteFunctions } from 'n8n-workflow';
import type { Mock } from 'vitest';
import { NodeOperationError } from 'n8n-workflow';
import { mockDeep } from 'vitest-mock-extended';

import { E2b } from '../E2b.node';

interface MockCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

interface MockSandbox {
	sandboxId: string;
	sandboxDomain: string;
	commands: {
		run: Mock<(command: string, options?: unknown) => Promise<MockCommandResult>>;
	};
	kill: Mock<(options?: unknown) => Promise<boolean>>;
}

const { Sandbox, CommandExitError, makeMockSandbox, resetE2BNodeMockState } = vi.hoisted(() => {
	class CommandExitError extends Error implements MockCommandResult {
		readonly exitCode: number;
		readonly stdout: string;
		readonly stderr: string;

		constructor(result: MockCommandResult) {
			super(result.stderr || result.stdout || `Command exited with ${result.exitCode}`);
			this.exitCode = result.exitCode;
			this.stdout = result.stdout;
			this.stderr = result.stderr;
		}
	}

	function makeMockSandbox(sandboxId = 'sb-node'): MockSandbox {
		return {
			sandboxId,
			sandboxDomain: `${sandboxId}.e2b.dev`,
			commands: {
				run: vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' })),
			},
			kill: vi.fn(async () => true),
		};
	}

	const Sandbox = {
		create: vi.fn(),
		connect: vi.fn(),
	};

	function resetE2BNodeMockState(): void {
		Sandbox.create.mockReset();
		Sandbox.connect.mockReset();
		Sandbox.create.mockResolvedValue(makeMockSandbox());
		Sandbox.connect.mockResolvedValue(makeMockSandbox());
	}

	resetE2BNodeMockState();

	return {
		Sandbox,
		CommandExitError,
		makeMockSandbox,
		resetE2BNodeMockState,
	};
});

vi.mock('e2b', () => ({
	Sandbox,
	CommandExitError,
}));

function setupExecuteFunctions(
	params: Record<string, unknown>,
	options: { throwOnMissingNestedParameter?: boolean } = {},
) {
	const executeFunctions = mockDeep<IExecuteFunctions>();
	executeFunctions.getInputData.mockReturnValue([{ json: {} }]);
	executeFunctions.getCredentials.mockResolvedValue({ apiKey: 'api-key' });
	executeFunctions.getNode.mockReturnValue({
		id: 'e2b-node',
		name: 'E2B',
		type: 'n8n-nodes-base.e2b',
		typeVersion: 1,
		position: [0, 0],
		parameters: {},
	});
	executeFunctions.getNodeParameter.mockImplementation(
		(name: string, _itemIndex?: number, fallback?: unknown) => {
			if (Object.prototype.hasOwnProperty.call(params, name)) return params[name] as never;
			if (options.throwOnMissingNestedParameter && name.includes('.') && fallback === undefined) {
				throw new Error(`Could not get parameter "${name}"`);
			}
			return fallback as never;
		},
	);
	executeFunctions.continueOnFail.mockReturnValue(false);
	return executeFunctions;
}

function defaultRunCommandParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		sandboxId: '',
		command: 'echo ok',
		cwd: '',
		'options.template': '',
		'options.metadataJson': '{}',
		'options.envJson': '{}',
		'options.allowInternetAccess': true,
		'options.cleanupPolicy': 'auto',
		'options.timeoutSeconds': 120,
		...overrides,
	};
}

beforeEach(() => {
	resetE2BNodeMockState();
});

describe('E2B node', () => {
	it('creates a sandbox, runs the command, and cleans up by default', async () => {
		const sandbox = makeMockSandbox('sb-created');
		Sandbox.create.mockResolvedValue(sandbox);
		const executeFunctions = setupExecuteFunctions(defaultRunCommandParams());

		const result = await new E2b().execute.call(executeFunctions);

		expect(Sandbox.create).toHaveBeenCalledWith(
			expect.objectContaining({
				apiKey: 'api-key',
				allowInternetAccess: true,
				requestTimeoutMs: 120_000,
				timeoutMs: 120_000,
			}),
		);
		expect(sandbox.commands.run).toHaveBeenCalledWith(
			'echo ok',
			expect.objectContaining({
				timeoutMs: 120_000,
				requestTimeoutMs: 120_000,
			}),
		);
		expect(sandbox.kill).toHaveBeenCalledWith(
			expect.objectContaining({
				apiKey: 'api-key',
				requestTimeoutMs: 120_000,
			}),
		);
		expect(result[0]?.[0]?.json).toEqual(
			expect.objectContaining({
				sandboxId: 'sb-created',
				createdSandbox: true,
				killedAfterRun: true,
				success: true,
				exitCode: 0,
				stdout: 'ok',
			}),
		);
	});

	it('uses default advanced options when the options collection is empty', async () => {
		const sandbox = makeMockSandbox('sb-empty-options');
		Sandbox.create.mockResolvedValue(sandbox);
		const executeFunctions = setupExecuteFunctions(
			{
				sandboxId: '',
				command: 'echo ok',
				cwd: '',
			},
			{ throwOnMissingNestedParameter: true },
		);

		const result = await new E2b().execute.call(executeFunctions);

		expect(Sandbox.create).toHaveBeenCalledWith(
			expect.objectContaining({
				allowInternetAccess: true,
				requestTimeoutMs: 300_000,
				timeoutMs: 300_000,
			}),
		);
		expect(sandbox.commands.run).toHaveBeenCalledWith(
			'echo ok',
			expect.objectContaining({
				timeoutMs: 300_000,
				requestTimeoutMs: 300_000,
			}),
		);
		expect(sandbox.kill).toHaveBeenCalledWith(
			expect.objectContaining({
				apiKey: 'api-key',
				requestTimeoutMs: 300_000,
			}),
		);
		expect(result[0]?.[0]?.json).toEqual(
			expect.objectContaining({
				sandboxId: 'sb-empty-options',
				createdSandbox: true,
				killedAfterRun: true,
				success: true,
			}),
		);
	});

	it('connects to an existing sandbox and keeps it by default', async () => {
		const sandbox = makeMockSandbox('sb-existing');
		Sandbox.connect.mockResolvedValue(sandbox);
		const executeFunctions = setupExecuteFunctions(
			defaultRunCommandParams({
				sandboxId: 'sb-existing',
			}),
		);

		const result = await new E2b().execute.call(executeFunctions);

		expect(Sandbox.connect).toHaveBeenCalledWith(
			'sb-existing',
			expect.objectContaining({
				apiKey: 'api-key',
				requestTimeoutMs: 120_000,
				timeoutMs: 120_000,
			}),
		);
		expect(sandbox.kill).not.toHaveBeenCalled();
		expect(result[0]?.[0]?.json).toEqual(
			expect.objectContaining({
				sandboxId: 'sb-existing',
				createdSandbox: false,
				killedAfterRun: false,
			}),
		);
	});

	it('kills an existing sandbox when cleanup is set to kill', async () => {
		const sandbox = makeMockSandbox('sb-existing');
		Sandbox.connect.mockResolvedValue(sandbox);
		const executeFunctions = setupExecuteFunctions(
			defaultRunCommandParams({
				sandboxId: 'sb-existing',
				'options.cleanupPolicy': 'kill',
			}),
		);

		const result = await new E2b().execute.call(executeFunctions);

		expect(sandbox.kill).toHaveBeenCalledWith(
			expect.objectContaining({
				apiKey: 'api-key',
				requestTimeoutMs: 120_000,
			}),
		);
		expect(result[0]?.[0]?.json).toEqual(
			expect.objectContaining({
				sandboxId: 'sb-existing',
				createdSandbox: false,
				killedAfterRun: true,
			}),
		);
	});

	it('passes sandbox and command options to E2B', async () => {
		const sandbox = makeMockSandbox('sb-options');
		Sandbox.create.mockResolvedValue(sandbox);
		const executeFunctions = setupExecuteFunctions(
			defaultRunCommandParams({
				cwd: '/workspace',
				'options.template': 'python3',
				'options.metadataJson': '{"workflow":"test"}',
				'options.envJson': '{"NODE_ENV":"test","RETRIES":2}',
				'options.allowInternetAccess': false,
				'options.cleanupPolicy': 'keep',
			}),
		);

		const result = await new E2b().execute.call(executeFunctions);

		expect(Sandbox.create).toHaveBeenCalledWith(
			expect.objectContaining({
				template: 'python3',
				metadata: { workflow: 'test' },
				envs: { NODE_ENV: 'test', RETRIES: '2' },
				allowInternetAccess: false,
			}),
		);
		expect(sandbox.commands.run).toHaveBeenCalledWith(
			'echo ok',
			expect.objectContaining({
				cwd: '/workspace',
				envs: { NODE_ENV: 'test', RETRIES: '2' },
			}),
		);
		expect(sandbox.kill).not.toHaveBeenCalled();
		expect(result[0]?.[0]?.json).toEqual(
			expect.objectContaining({
				sandboxId: 'sb-options',
				killedAfterRun: false,
			}),
		);
	});

	it('kills a created sandbox when command execution fails unexpectedly', async () => {
		const sandbox = makeMockSandbox('sb-cleanup');
		sandbox.commands.run.mockRejectedValue(new Error('network reset'));
		Sandbox.create.mockResolvedValue(sandbox);
		const executeFunctions = setupExecuteFunctions(defaultRunCommandParams());

		await expect(new E2b().execute.call(executeFunctions)).rejects.toThrow(/network reset/i);

		expect(sandbox.kill).toHaveBeenCalledWith(
			expect.objectContaining({
				apiKey: 'api-key',
				requestTimeoutMs: 120_000,
			}),
		);
	});

	it('kills a created sandbox after a handled command exit', async () => {
		const sandbox = makeMockSandbox('sb-command-exit');
		sandbox.commands.run.mockRejectedValue(
			new CommandExitError({ exitCode: 2, stdout: '', stderr: 'command failed' }),
		);
		Sandbox.create.mockResolvedValue(sandbox);
		const executeFunctions = setupExecuteFunctions(defaultRunCommandParams());

		const result = await new E2b().execute.call(executeFunctions);

		expect(result[0]?.[0]?.json).toEqual(
			expect.objectContaining({
				sandboxId: 'sb-command-exit',
				success: false,
				exitCode: 2,
				stderr: 'command failed',
				killedAfterRun: true,
			}),
		);
		expect(sandbox.kill).toHaveBeenCalledWith(
			expect.objectContaining({
				apiKey: 'api-key',
				requestTimeoutMs: 120_000,
			}),
		);
	});

	it('fails visibly when cleanup fails after a successful command', async () => {
		const sandbox = makeMockSandbox('sb-cleanup-fail');
		sandbox.kill.mockRejectedValue(new Error('cleanup failed'));
		Sandbox.create.mockResolvedValue(sandbox);
		const executeFunctions = setupExecuteFunctions(defaultRunCommandParams());

		let error: unknown;
		try {
			await new E2b().execute.call(executeFunctions);
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(NodeOperationError);
		expect(error).toBeInstanceOf(Error);
		if (error instanceof Error) {
			expect(error.message).toMatch(/cleanup failed/i);
		}
	});
});
