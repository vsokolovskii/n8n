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

interface MockSandboxInfo {
	sandboxId: string;
	templateId: string;
	name?: string;
	state: 'running' | 'paused';
	metadata: Record<string, string>;
	startedAt: Date;
	endAt: Date;
	cpuCount: number;
	memoryMB: number;
	envdVersion: string;
}

interface MockSnapshotInfo {
	snapshotId: string;
	names: string[];
}

interface MockSandbox {
	sandboxId: string;
	sandboxDomain: string;
	commands: {
		run: Mock<(command: string, options?: unknown) => Promise<MockCommandResult>>;
	};
	getInfo: Mock<() => Promise<MockSandboxInfo>>;
	kill: Mock<() => Promise<boolean>>;
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

	function makeSandboxInfo(sandboxId: string): MockSandboxInfo {
		return {
			sandboxId,
			templateId: 'base',
			name: 'base',
			state: 'running',
			metadata: {},
			startedAt: new Date('2026-01-01T00:00:00.000Z'),
			endAt: new Date('2026-01-01T00:05:00.000Z'),
			cpuCount: 2,
			memoryMB: 1024,
			envdVersion: '0.1.0',
		};
	}

	function makeMockSandbox(sandboxId = 'sb-node'): MockSandbox {
		return {
			sandboxId,
			sandboxDomain: `${sandboxId}.e2b.dev`,
			commands: {
				run: vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' })),
			},
			getInfo: vi.fn(async () => makeSandboxInfo(sandboxId)),
			kill: vi.fn(async () => true),
		};
	}

	const Sandbox = {
		create: vi.fn(),
		connect: vi.fn(),
		list: vi.fn(),
		listSnapshots: vi.fn(),
		getInfo: vi.fn(),
		createSnapshot: vi.fn(),
		deleteSnapshot: vi.fn(),
		pause: vi.fn(),
		kill: vi.fn(),
	};

	function resetE2BNodeMockState(): void {
		Sandbox.create.mockReset();
		Sandbox.connect.mockReset();
		Sandbox.list.mockReset();
		Sandbox.listSnapshots.mockReset();
		Sandbox.getInfo.mockReset();
		Sandbox.createSnapshot.mockReset();
		Sandbox.deleteSnapshot.mockReset();
		Sandbox.pause.mockReset();
		Sandbox.kill.mockReset();
		Sandbox.create.mockResolvedValue(makeMockSandbox());
		Sandbox.connect.mockResolvedValue(makeMockSandbox());
		Sandbox.list.mockReturnValue({ nextItems: vi.fn(async () => []) });
		Sandbox.listSnapshots.mockReturnValue({ nextItems: vi.fn(async () => []) });
		Sandbox.getInfo.mockResolvedValue(makeSandboxInfo('sb-node'));
		Sandbox.createSnapshot.mockResolvedValue({
			snapshotId: 'snap-node:default',
			names: ['team/snap-node:default'],
		} satisfies MockSnapshotInfo);
		Sandbox.deleteSnapshot.mockResolvedValue(true);
		Sandbox.pause.mockResolvedValue(true);
		Sandbox.kill.mockResolvedValue(true);
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

function setupExecuteFunctions(params: Record<string, unknown>) {
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
		(name: string, _itemIndex?: number, fallback?: unknown) =>
			(params[name] ?? fallback) as never,
	);
	executeFunctions.continueOnFail.mockReturnValue(false);
	return executeFunctions;
}

function defaultRunCommandParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		operation: 'runCommand',
		sandboxId: '',
		command: 'echo ok',
		cwd: '',
		template: '',
		metadataJson: '{}',
		envJson: '{}',
		allowInternetAccess: true,
		killAfterRun: true,
		timeoutSeconds: 120,
		...overrides,
	};
}

beforeEach(() => {
	resetE2BNodeMockState();
});

describe('E2B node', () => {
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

	it('fails visibly when killAfterRun cleanup fails after a successful command', async () => {
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

	it('creates a snapshot from a sandbox', async () => {
		const executeFunctions = setupExecuteFunctions({
			operation: 'createSnapshot',
			sandboxId: 'sb-source',
			snapshotName: 'checkpoint',
			timeoutSeconds: 120,
		});

		const result = await new E2b().execute.call(executeFunctions);

		expect(Sandbox.createSnapshot).toHaveBeenCalledWith(
			'sb-source',
			expect.objectContaining({
				apiKey: 'api-key',
				name: 'checkpoint',
				requestTimeoutMs: 120_000,
			}),
		);
		expect(result[0]?.[0]?.json).toEqual({
			snapshotId: 'snap-node:default',
			names: ['team/snap-node:default'],
		});
	});

	it('lists snapshots with an optional source sandbox filter', async () => {
		Sandbox.listSnapshots.mockReturnValue({
			nextItems: vi.fn(async () => [
				{
					snapshotId: 'snap-one:default',
					names: ['team/snap-one:default'],
				},
			]),
		});
		const executeFunctions = setupExecuteFunctions({
			operation: 'listSnapshots',
			sandboxId: 'sb-source',
			limit: 10,
			timeoutSeconds: 120,
		});

		const result = await new E2b().execute.call(executeFunctions);

		expect(Sandbox.listSnapshots).toHaveBeenCalledWith(
			expect.objectContaining({
				apiKey: 'api-key',
				sandboxId: 'sb-source',
				limit: 10,
				requestTimeoutMs: 120_000,
			}),
		);
		expect(result[0]?.[0]?.json).toEqual({
			snapshotId: 'snap-one:default',
			names: ['team/snap-one:default'],
		});
	});

	it('deletes a snapshot', async () => {
		const executeFunctions = setupExecuteFunctions({
			operation: 'deleteSnapshot',
			snapshotId: 'snap-node:default',
			timeoutSeconds: 120,
		});

		const result = await new E2b().execute.call(executeFunctions);

		expect(Sandbox.deleteSnapshot).toHaveBeenCalledWith(
			'snap-node:default',
			expect.objectContaining({
				apiKey: 'api-key',
				requestTimeoutMs: 120_000,
			}),
		);
		expect(result[0]?.[0]?.json).toEqual({
			snapshotId: 'snap-node:default',
			deleted: true,
		});
	});
});
