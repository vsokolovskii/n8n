import type { Mock } from 'vitest';

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

interface MockE2BSandbox {
	sandboxId: string;
	sandboxDomain: string;
	commands: {
		run: Mock<(command: string, options?: unknown) => Promise<MockCommandResult>>;
	};
	files: {
		read: Mock<(path: string, options?: unknown) => Promise<string | Uint8Array>>;
		write: Mock<(path: string, content: string | ArrayBuffer) => Promise<void>>;
		list: Mock<(path: string) => Promise<MockEntryInfo[]>>;
		makeDir: Mock<(path: string) => Promise<boolean>>;
		rename: Mock<(oldPath: string, newPath: string) => Promise<MockEntryInfo>>;
		remove: Mock<(path: string) => Promise<void>>;
		exists: Mock<(path: string) => Promise<boolean>>;
		getInfo: Mock<(path: string) => Promise<MockEntryInfo>>;
	};
	getInfo: Mock<() => Promise<MockSandboxInfo>>;
	pause: Mock<() => Promise<boolean>>;
	kill: Mock<() => Promise<boolean>>;
}

interface MockEntryInfo {
	name: string;
	path: string;
	type: 'dir' | 'file';
	size: number;
	modifiedTime?: Date;
}

const {
	Sandbox,
	SandboxNotFoundError,
	FileNotFoundError,
	CommandExitError,
	FileType,
	makeMockSandbox,
	makeSandboxInfo,
	resetE2BMockState,
	queuedCreateResults,
	queuedConnectResults,
	queuedConnectErrors,
	queuedInfoResults,
	queuedInfoErrors,
} = vi.hoisted(() => {
	const queuedCreateResults: MockE2BSandbox[] = [];
	const queuedConnectResults: MockE2BSandbox[] = [];
	const queuedConnectErrors: Error[] = [];
	const queuedInfoResults: MockSandboxInfo[] = [];
	const queuedInfoErrors: Error[] = [];
	let nextSandboxId = 1;

	class SandboxNotFoundError extends Error {}
	class FileNotFoundError extends Error {}
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

	const FileType = {
		DIR: 'dir',
		FILE: 'file',
	} as const;

	async function tick(): Promise<void> {
		await Promise.resolve();
	}

	function makeSandboxInfo(
		sandboxId: string,
		state: 'running' | 'paused' = 'running',
	): MockSandboxInfo {
		return {
			sandboxId,
			templateId: 'base',
			name: 'base',
			state,
			metadata: {},
			startedAt: new Date('2026-01-01T00:00:00.000Z'),
			endAt: new Date('2026-01-01T00:05:00.000Z'),
			cpuCount: 2,
			memoryMB: 1024,
			envdVersion: '0.1.0',
		};
	}

	function makeMockSandbox(sandboxId = `sb-${nextSandboxId++}`): MockE2BSandbox {
		const info = makeSandboxInfo(sandboxId);
		return {
			sandboxId,
			sandboxDomain: `${sandboxId}.e2b.dev`,
			commands: {
				run: vi.fn(async (command: string) => {
					await tick();
					if (command === 'pwd') {
						return { exitCode: 0, stdout: '/home/user/workspace\n', stderr: '' };
					}
					return { exitCode: 0, stdout: 'ok', stderr: '' };
				}),
			},
			files: {
				read: vi.fn(async () => {
					await tick();
					return new Uint8Array();
				}),
				write: vi.fn(async () => {
					await tick();
				}),
				list: vi.fn(async () => {
					await tick();
					return [];
				}),
				makeDir: vi.fn(async () => {
					await tick();
					return true;
				}),
				rename: vi.fn(async (_oldPath: string, newPath: string) => {
					await tick();
					return {
						name: newPath.split('/').pop() ?? '',
						path: newPath,
						type: FileType.FILE,
						size: 0,
					};
				}),
				remove: vi.fn(async () => {
					await tick();
				}),
				exists: vi.fn(async () => {
					await tick();
					return true;
				}),
				getInfo: vi.fn(async (path: string) => {
					await tick();
					return {
						name: path.split('/').pop() ?? '',
						path,
						type: FileType.FILE,
						size: 0,
						modifiedTime: new Date('2026-01-01T00:00:00.000Z'),
					};
				}),
			},
			getInfo: vi.fn(async () => {
				await tick();
				return info;
			}),
			pause: vi.fn(async () => {
				await tick();
				return true;
			}),
			kill: vi.fn(async () => {
				await tick();
				return true;
			}),
		};
	}

	const Sandbox = {
		create: vi.fn(),
		connect: vi.fn(),
		list: vi.fn(),
		getInfo: vi.fn(),
		pause: vi.fn(),
		kill: vi.fn(),
	};

	function setDefaultImplementations(): void {
		Sandbox.create.mockImplementation(async () => {
			await tick();
			return queuedCreateResults.shift() ?? makeMockSandbox();
		});
		Sandbox.connect.mockImplementation(async (sandboxId: string) => {
			await tick();
			const error = queuedConnectErrors.shift();
			if (error) throw error;
			return queuedConnectResults.shift() ?? makeMockSandbox(sandboxId);
		});
		Sandbox.list.mockImplementation(() => ({
			nextItems: vi.fn(async () => {
				await tick();
				return [];
			}),
		}));
		Sandbox.getInfo.mockImplementation(async (sandboxId: string) => {
			await tick();
			const error = queuedInfoErrors.shift();
			if (error) throw error;
			return queuedInfoResults.shift() ?? makeSandboxInfo(sandboxId);
		});
		Sandbox.pause.mockResolvedValue(true);
		Sandbox.kill.mockResolvedValue(true);
	}

	function resetE2BMockState(): void {
		nextSandboxId = 1;
		queuedCreateResults.length = 0;
		queuedConnectResults.length = 0;
		queuedConnectErrors.length = 0;
		queuedInfoResults.length = 0;
		queuedInfoErrors.length = 0;
		Sandbox.create.mockReset();
		Sandbox.connect.mockReset();
		Sandbox.list.mockReset();
		Sandbox.getInfo.mockReset();
		Sandbox.pause.mockReset();
		Sandbox.kill.mockReset();
		setDefaultImplementations();
	}

	setDefaultImplementations();

	return {
		Sandbox,
		SandboxNotFoundError,
		FileNotFoundError,
		CommandExitError,
		FileType,
		makeMockSandbox,
		makeSandboxInfo,
		resetE2BMockState,
		queuedCreateResults,
		queuedConnectResults,
		queuedConnectErrors,
		queuedInfoResults,
		queuedInfoErrors,
	};
});

vi.mock('../../../workspace/sandbox/lazy-e2b', () => ({
	loadE2B: () => ({
		Sandbox,
		SandboxNotFoundError,
		FileNotFoundError,
		CommandExitError,
		FileType,
	}),
}));

import { E2BFilesystem } from '../../../workspace/filesystem/e2b-filesystem';
import { E2BSandbox } from '../../../workspace/sandbox/e2b-sandbox';

beforeEach(() => {
	resetE2BMockState();
});

describe('E2BSandbox', () => {
	it('creates a sandbox with E2B options', async () => {
		const sandbox = new E2BSandbox({
			apiKey: 'api-key',
			apiUrl: 'https://api.e2b.example',
			domain: 'e2b.example',
			sandboxUrl: 'https://sandbox.e2b.example',
			template: 'base',
			timeout: 60_000,
			requestTimeoutMs: 10_000,
			metadata: { thread_id: 'thread-1' },
			env: { N8N_TEST: 'true' },
			secure: false,
			allowInternetAccess: false,
			lifecycle: { onTimeout: 'pause', autoResume: true },
		});

		await sandbox.start();

		expect(Sandbox.create).toHaveBeenCalledWith(
			expect.objectContaining({
				apiKey: 'api-key',
				apiUrl: 'https://api.e2b.example',
				domain: 'e2b.example',
				sandboxUrl: 'https://sandbox.e2b.example',
				template: 'base',
				timeoutMs: 60_000,
				requestTimeoutMs: 10_000,
				metadata: { thread_id: 'thread-1' },
				envs: { N8N_TEST: 'true' },
				secure: false,
				allowInternetAccess: false,
				lifecycle: { onTimeout: 'pause', autoResume: true },
			}),
		);
	});

	it('recovers by creating a new sandbox when the remote sandbox is gone', async () => {
		const stale = makeMockSandbox('sb-stale');
		stale.commands.run.mockImplementation(async (command: string) => {
			await Promise.resolve();
			if (command === 'pwd') {
				return { exitCode: 0, stdout: '/home/user/workspace\n', stderr: '' };
			}
			throw new SandboxNotFoundError('sandbox gone');
		});
		const fresh = makeMockSandbox('sb-fresh');
		queuedCreateResults.push(stale, fresh);
		queuedConnectErrors.push(new SandboxNotFoundError('sandbox gone'));

		const sandbox = new E2BSandbox({ apiKey: 'api-key' });
		const result = await sandbox.executeCommand('echo', ['hi']);

		expect(result.success).toBe(true);
		expect(result.stdout).toBe('ok');
		expect(Sandbox.create).toHaveBeenCalledTimes(2);
		expect(Sandbox.connect).toHaveBeenCalledWith('sb-stale', expect.any(Object));
		expect(fresh.commands.run).toHaveBeenCalledWith('echo hi', expect.any(Object));
	});

	it('recovers a paused remote sandbox by reconnecting it', async () => {
		const stale = makeMockSandbox('sb-paused');
		stale.commands.run.mockImplementation(async (command: string) => {
			await Promise.resolve();
			if (command === 'pwd') {
				return { exitCode: 0, stdout: '/home/user/workspace\n', stderr: '' };
			}
			throw new Error('sandbox is paused');
		});
		const resumed = makeMockSandbox('sb-paused');
		queuedCreateResults.push(stale);
		queuedInfoResults.push(makeSandboxInfo('sb-paused', 'paused'));
		queuedConnectResults.push(resumed);

		const sandbox = new E2BSandbox({ apiKey: 'api-key' });
		const result = await sandbox.executeCommand('echo', ['hi']);

		expect(result.success).toBe(true);
		expect(Sandbox.getInfo).toHaveBeenCalledWith(
			'sb-paused',
			expect.objectContaining({ apiKey: 'api-key' }),
		);
		expect(Sandbox.connect).toHaveBeenCalledWith('sb-paused', expect.any(Object));
		expect(Sandbox.create).toHaveBeenCalledTimes(1);
	});

	it('recovers getInfo() from a paused remote sandbox', async () => {
		const stale = makeMockSandbox('sb-paused');
		stale.getInfo.mockRejectedValue(new Error('sandbox is paused'));
		const resumed = makeMockSandbox('sb-paused');
		queuedCreateResults.push(stale);
		queuedInfoResults.push(makeSandboxInfo('sb-paused', 'paused'));
		queuedConnectResults.push(resumed);

		const sandbox = new E2BSandbox({ apiKey: 'api-key' });
			const info = await sandbox.getInfo();

			expect(info.id).toBe('sb-paused');
			expect(info.metadata).toEqual(expect.objectContaining({ state: 'running' }));
			expect(Sandbox.getInfo).toHaveBeenCalledWith(
				'sb-paused',
				expect.objectContaining({ apiKey: 'api-key' }),
		);
		expect(Sandbox.connect).toHaveBeenCalledWith('sb-paused', expect.any(Object));
	});

	it('does not recover when the remote sandbox is still running', async () => {
		const stale = makeMockSandbox('sb-running');
		stale.commands.run.mockImplementation(async (command: string) => {
			await Promise.resolve();
			if (command === 'pwd') {
				return { exitCode: 0, stdout: '/home/user/workspace\n', stderr: '' };
			}
			throw new Error('genuine command failure');
		});
		queuedCreateResults.push(stale);
		queuedInfoResults.push(makeSandboxInfo('sb-running', 'running'));

		const sandbox = new E2BSandbox({ apiKey: 'api-key' });

		await expect(sandbox.executeCommand('echo', ['hi'])).rejects.toThrow(
			/genuine command failure/i,
		);
		expect(Sandbox.connect).not.toHaveBeenCalled();
		expect(Sandbox.create).toHaveBeenCalledTimes(1);
	});

	it('does not recover when the state probe fails without proving the sandbox is gone', async () => {
		const stale = makeMockSandbox('sb-auth');
		stale.commands.run.mockImplementation(async (command: string) => {
			await Promise.resolve();
			if (command === 'pwd') {
				return { exitCode: 0, stdout: '/home/user/workspace\n', stderr: '' };
			}
			throw new Error('endpoint not allowed');
		});
		queuedCreateResults.push(stale);
		queuedInfoErrors.push(new Error('unauthorized'));

		const sandbox = new E2BSandbox({ apiKey: 'api-key' });

		await expect(sandbox.executeCommand('echo', ['hi'])).rejects.toThrow(/endpoint not allowed/i);
		expect(Sandbox.connect).not.toHaveBeenCalled();
		expect(Sandbox.create).toHaveBeenCalledTimes(1);
	});

	it('retries recovery at most once', async () => {
		const stale = makeMockSandbox('sb-stale');
		stale.commands.run.mockImplementation(async (command: string) => {
			await Promise.resolve();
			if (command === 'pwd') {
				return { exitCode: 0, stdout: '/home/user/workspace\n', stderr: '' };
			}
			throw new SandboxNotFoundError('sandbox gone');
		});
		const fresh = makeMockSandbox('sb-fresh');
		fresh.commands.run.mockImplementation(async (command: string) => {
			await Promise.resolve();
			if (command === 'pwd') {
				return { exitCode: 0, stdout: '/home/user/workspace\n', stderr: '' };
			}
			throw new SandboxNotFoundError('still gone');
		});
		queuedCreateResults.push(stale, fresh);
		queuedConnectErrors.push(new SandboxNotFoundError('sandbox gone'));

		const sandbox = new E2BSandbox({ apiKey: 'api-key' });

		await expect(sandbox.executeCommand('echo', ['hi'])).rejects.toThrow(/still gone/i);
		expect(Sandbox.create).toHaveBeenCalledTimes(2);
	});
});

describe('E2BFilesystem', () => {
	it('recovers a paused sandbox instead of treating exists() as missing', async () => {
		const stale = makeMockSandbox('sb-paused');
		stale.files.exists.mockRejectedValue(new Error('sandbox is paused'));
		const resumed = makeMockSandbox('sb-paused');
		resumed.files.exists.mockResolvedValue(true);
		queuedCreateResults.push(stale);
		queuedInfoResults.push(makeSandboxInfo('sb-paused', 'paused'));
		queuedConnectResults.push(resumed);

		const sandbox = new E2BSandbox({ apiKey: 'api-key' });
		const filesystem = new E2BFilesystem(sandbox);

		await expect(filesystem.exists('/home/user/workspace/marker')).resolves.toBe(true);
		expect(Sandbox.connect).toHaveBeenCalledWith('sb-paused', expect.any(Object));
	});

	it('treats a genuine missing file as empty for appendFile()', async () => {
		const handle = makeMockSandbox('sb-1');
		handle.files.read.mockRejectedValue(new FileNotFoundError('file not found'));
		queuedCreateResults.push(handle);

		const sandbox = new E2BSandbox({ apiKey: 'api-key' });
		const filesystem = new E2BFilesystem(sandbox);

		await filesystem.appendFile('/home/user/workspace/log.txt', 'entry');

		expect(handle.files.write).toHaveBeenCalledWith(
			'/home/user/workspace/log.txt',
			expect.any(ArrayBuffer),
		);
		expect(Sandbox.connect).not.toHaveBeenCalled();
	});

	it('does not recover a file-not-found stat error when the sandbox is running', async () => {
		const handle = makeMockSandbox('sb-1');
		handle.files.getInfo.mockRejectedValue(new FileNotFoundError('file not found'));
		queuedCreateResults.push(handle);
		queuedInfoResults.push(makeSandboxInfo('sb-1', 'running'));

		const sandbox = new E2BSandbox({ apiKey: 'api-key' });
		const filesystem = new E2BFilesystem(sandbox);

		await expect(filesystem.stat('/home/user/workspace/missing.txt')).rejects.toBeInstanceOf(
			FileNotFoundError,
		);
		expect(Sandbox.connect).not.toHaveBeenCalled();
	});
});
