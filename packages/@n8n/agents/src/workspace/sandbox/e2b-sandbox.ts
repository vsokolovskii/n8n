import type {
	CommandResult as E2BCommandResult,
	Filesystem as E2BFilesystemHandle,
	Sandbox as E2BSdkSandbox,
	SandboxApiOpts,
	SandboxConnectOpts,
	SandboxInfo as E2BSandboxInfo,
	SandboxLifecycle,
	SandboxNetworkOpts,
	SandboxOpts,
	SandboxState,
} from 'e2b';
import { randomUUID } from 'node:crypto';

import type { CommandResult, ExecuteCommandOptions, ProviderStatus, SandboxInfo } from '../types';
import { BaseSandbox } from './base-sandbox';
import { loadE2B } from './lazy-e2b';

const RUNNING_SANDBOX_STATES: SandboxState[] = ['running', 'paused'];
const RECOVERABLE_SANDBOX_STATES: ReadonlySet<SandboxState> = new Set(['paused']);

export interface E2BSandboxOptions {
	/** Remote E2B sandbox ID. E2B does not support caller-selected sandbox names. */
	id?: string;
	apiKey?: string;
	apiUrl?: string;
	domain?: string;
	sandboxUrl?: string;
	template?: string;
	timeout?: number;
	requestTimeoutMs?: number;
	metadata?: Record<string, string>;
	env?: Record<string, string>;
	secure?: boolean;
	allowInternetAccess?: boolean;
	network?: SandboxNetworkOpts;
	lifecycle?: SandboxLifecycle;
}

function shellEscape(value: string): string {
	return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function toShellCommand(command: string, args: string[]): string {
	if (args.length === 0) return command;
	return [command, ...args.map((arg) => shellEscape(arg))].join(' ');
}

function hasMetadata(metadata: Record<string, string> | undefined): metadata is Record<string, string> {
	return metadata !== undefined && Object.keys(metadata).length > 0;
}

function isSandboxGone(error: unknown): boolean {
	const { SandboxNotFoundError } = loadE2B();
	return error instanceof SandboxNotFoundError;
}

export class E2BSandbox extends BaseSandbox {
	readonly name = 'E2BSandbox';
	readonly provider = 'e2b';
	status: ProviderStatus = 'pending';

	private readonly localId = `e2b-sandbox-${randomUUID()}`;
	private readonly timeout: number;
	private readonly createdAt = new Date();
	private sandboxId?: string;
	private sandbox?: E2BSdkSandbox;
	private workingDirectory?: string;
	private recoveryPromise?: Promise<void>;

	constructor(private readonly options: E2BSandboxOptions = {}) {
		super();
		this.timeout = options.timeout ?? 300_000;
		this.sandboxId = options.id;
	}

	get id(): string {
		return this.sandboxId ?? this.localId;
	}

	get instance(): E2BSdkSandbox {
		if (!this.sandbox) {
			throw new Error(`E2B sandbox "${this.id}" is not running`);
		}
		return this.sandbox;
	}

	override async start(): Promise<void> {
		if (this.sandbox) return;

		const existing = await this.findExistingSandbox();
		if (existing) {
			await this.bindSandbox(existing);
			return;
		}

		const { Sandbox } = loadE2B();
		const sandbox = await Sandbox.create(this.buildCreateOpts());
		await this.bindSandbox(sandbox);
	}

	override async stop(): Promise<void> {
		if (!this.sandbox && !this.sandboxId) return;
		try {
			if (this.sandbox) {
				await this.sandbox.pause(this.buildConnectionOpts());
			} else if (this.sandboxId) {
				const { Sandbox } = loadE2B();
				await Sandbox.pause(this.sandboxId, this.buildApiOpts());
			}
		} catch (error) {
			if (!isSandboxGone(error)) throw error;
		}
		this.sandbox = undefined;
		this.workingDirectory = undefined;
	}

	override async destroy(): Promise<void> {
		try {
			if (this.sandbox) {
				await this.sandbox.kill(this.buildApiOpts());
			} else if (this.sandboxId) {
				const { Sandbox } = loadE2B();
				await Sandbox.kill(this.sandboxId, this.buildApiOpts());
			}
		} catch (error) {
			if (!isSandboxGone(error)) throw error;
		}
		this.sandbox = undefined;
		this.workingDirectory = undefined;
	}

	override async executeCommand(
		command: string,
		args: string[] = [],
		options?: ExecuteCommandOptions,
	): Promise<CommandResult> {
		return await this.recoverAndRetry(async () => {
			await this.ensureRunning();
			const startedAt = Date.now();
			const fullCommand = toShellCommand(command, args);
			try {
				const result = await this.instance.commands.run(fullCommand, {
					cwd: options?.cwd,
					envs: this.compactEnv(options?.env),
					timeoutMs: options?.timeout ?? this.timeout,
					requestTimeoutMs: options?.timeout ?? this.options.requestTimeoutMs ?? this.timeout,
					onStdout: options?.onStdout,
					onStderr: options?.onStderr,
					signal: options?.abortSignal,
				});

				return this.toCommandResult(command, args, result, startedAt);
			} catch (error) {
				const { CommandExitError } = loadE2B();
				if (error instanceof CommandExitError) {
					return this.toCommandResult(command, args, error, startedAt);
				}
				throw error;
			}
		});
	}

	/**
	 * Run a filesystem operation against the live E2B filesystem handle, ensuring the
	 * sandbox is running and reconnecting once if the remote sandbox disappeared.
	 */
	async withFilesystem<T>(op: (files: E2BFilesystemHandle) => Promise<T>): Promise<T> {
		return await this.recoverAndRetry(async () => {
			await this.ensureRunning();
			return await op(this.instance.files);
		});
	}

	async getInfo(): Promise<SandboxInfo> {
		return await this.recoverAndRetry(async () => {
			await this.ensureRunning();
			const remote = await this.instance.getInfo(this.buildApiOpts());
			return {
				id: this.id,
				name: this.name,
				provider: this.provider,
				status: this.status,
				createdAt: remote.startedAt ?? this.createdAt,
				resources: {
					cpuCores: remote.cpuCount,
					memoryMB: remote.memoryMB,
				},
				metadata: this.toInfoMetadata(remote),
			};
		});
	}

	override getInstructions(): string {
		const parts = ['Cloud sandbox with isolated execution (E2B runtime).'];
		if (this.workingDirectory) {
			parts.push(`Default working directory: ${this.workingDirectory}.`);
		}
		parts.push(`Command timeout: ${Math.ceil(this.timeout / 1000)}s.`);
		return parts.join(' ');
	}

	private async bindSandbox(sandbox: E2BSdkSandbox): Promise<void> {
		this.sandbox = sandbox;
		this.sandboxId = sandbox.sandboxId;
		await this.detectWorkingDirectory();
	}

	private async findExistingSandbox(): Promise<E2BSdkSandbox | null> {
		const { Sandbox } = loadE2B();
		if (this.sandboxId) {
			try {
				return await Sandbox.connect(this.sandboxId, this.buildConnectionOpts());
			} catch (error) {
				if (!isSandboxGone(error)) throw error;
			}
		}

		if (!hasMetadata(this.options.metadata)) return null;

		const paginator = Sandbox.list({
			...this.buildApiOpts(),
			query: {
				metadata: this.options.metadata,
				state: RUNNING_SANDBOX_STATES,
			},
			limit: 1,
		});
		const [existing] = await paginator.nextItems();
		if (!existing) return null;
		return await Sandbox.connect(existing.sandboxId, this.buildConnectionOpts());
	}

	private resetLocalHandle(): void {
		this.sandbox = undefined;
		this.workingDirectory = undefined;
		this.markNeedsStart();
	}

	private async recoverAndRetry<T>(op: () => Promise<T>): Promise<T> {
		try {
			return await op();
		} catch (error) {
			if (!(await this.isRecoverable(error))) throw error;
			await this.recover();
			return await op();
		}
	}

	private async isRecoverable(error: unknown): Promise<boolean> {
		if (isSandboxGone(error)) return true;
		if (!this.sandboxId) return false;

		try {
			const { Sandbox } = loadE2B();
			const remote = await Sandbox.getInfo(this.sandboxId, this.buildApiOpts());
			return RECOVERABLE_SANDBOX_STATES.has(remote.state);
		} catch (probeError) {
			return isSandboxGone(probeError);
		}
	}

	private async recover(): Promise<void> {
		this.recoveryPromise ??= (async () => {
			this.resetLocalHandle();
			await this.ensureRunning();
		})().finally(() => {
			this.recoveryPromise = undefined;
		});
		await this.recoveryPromise;
	}

	private async detectWorkingDirectory(): Promise<void> {
		try {
			const result = await this.instance.commands.run('pwd', {
				timeoutMs: this.timeout,
				requestTimeoutMs: this.options.requestTimeoutMs ?? this.timeout,
			});
			this.workingDirectory = result.stdout.trim() || undefined;
		} catch {
			this.workingDirectory = undefined;
		}
	}

	private buildConnectionOpts(): SandboxConnectOpts {
		return {
			...this.buildBaseConnectionOpts(),
			timeoutMs: this.timeout,
		};
	}

	private buildCreateOpts(): SandboxOpts {
		return {
			...this.buildBaseConnectionOpts(),
			...(this.options.template ? { template: this.options.template } : {}),
			...(hasMetadata(this.options.metadata) ? { metadata: this.options.metadata } : {}),
			...(this.options.env ? { envs: this.options.env } : {}),
			...(this.options.secure !== undefined ? { secure: this.options.secure } : {}),
			...(this.options.allowInternetAccess !== undefined
				? { allowInternetAccess: this.options.allowInternetAccess }
				: {}),
			...(this.options.network ? { network: this.options.network } : {}),
			...(this.options.lifecycle ? { lifecycle: this.options.lifecycle } : {}),
			timeoutMs: this.timeout,
		};
	}

	private buildBaseConnectionOpts(): SandboxOpts {
		return {
			...(this.options.apiKey ? { apiKey: this.options.apiKey } : {}),
			...(this.options.apiUrl ? { apiUrl: this.options.apiUrl } : {}),
			...(this.options.domain ? { domain: this.options.domain } : {}),
			...(this.options.sandboxUrl ? { sandboxUrl: this.options.sandboxUrl } : {}),
			requestTimeoutMs: this.options.requestTimeoutMs ?? this.timeout,
		};
	}

	private buildApiOpts(): SandboxApiOpts {
		return {
			...(this.options.apiKey ? { apiKey: this.options.apiKey } : {}),
			...(this.options.domain ? { domain: this.options.domain } : {}),
			requestTimeoutMs: this.options.requestTimeoutMs ?? this.timeout,
		};
	}

	private compactEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> | undefined {
		const merged = {
			...this.options.env,
			...env,
		};
		const entries = Object.entries(merged).filter(
			(entry): entry is [string, string] => typeof entry[1] === 'string',
		);
		return entries.length > 0 ? Object.fromEntries(entries) : undefined;
	}

	private toCommandResult(
		command: string,
		args: string[],
		result: E2BCommandResult,
		startedAt: number,
	): CommandResult {
		return {
			command,
			args,
			success: result.exitCode === 0,
			exitCode: result.exitCode,
			stdout: result.stdout,
			stderr: result.stderr,
			executionTimeMs: Date.now() - startedAt,
		};
	}

	private toInfoMetadata(remote: E2BSandboxInfo): Record<string, unknown> {
		return {
			...remote.metadata,
			workingDirectory: this.workingDirectory,
			remoteSandboxId: remote.sandboxId,
			templateId: remote.templateId,
			templateName: remote.name,
			state: remote.state,
			endAt: remote.endAt,
			envdVersion: remote.envdVersion,
			sandboxDomain: this.sandbox?.sandboxDomain,
		};
	}
}
