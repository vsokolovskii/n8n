import type { CreateSandboxFromImageParams } from '@daytonaio/sdk';
import type { SandboxLifecycle, SandboxNetworkOpts } from 'e2b';

import type { BaseFilesystemOptions } from '../filesystem/base-filesystem';
import type {
	BaseSandboxOptions,
	CommandOptions,
	CommandResult,
	CopyOptions,
	ExecuteCommandOptions,
	FileContent,
	FileEntry,
	FileStat,
	ListOptions,
	MountConfig,
	ProcessHandle,
	ProcessInfo,
	ProviderStatus,
	ReadOptions,
	RemoveOptions,
	SandboxInfo,
	SandboxProcessManager,
	SpawnProcessOptions,
	WorkspaceFilesystem,
	WorkspaceSandbox,
	WriteOptions,
} from '../types';
import type { ErrorReporter, Logger } from './logger';

export type {
	BaseFilesystemOptions,
	BaseSandboxOptions,
	CommandOptions,
	CommandResult,
	CopyOptions,
	ExecuteCommandOptions,
	FileContent,
	FileEntry,
	FileStat,
	ListOptions,
	MountConfig,
	ProcessHandle,
	ProcessInfo,
	ProviderStatus,
	ReadOptions,
	RemoveOptions,
	SandboxInfo,
	SandboxProcessManager,
	SpawnProcessOptions,
	WorkspaceFilesystem,
	WorkspaceSandbox,
	WriteOptions,
};

export type SandboxProvider = 'daytona' | 'n8n-sandbox' | 'e2b';

export interface SandboxConfigBase {
	provider: SandboxProvider;
	timeout?: number;
}

export interface DisabledSandboxConfig extends SandboxConfigBase {
	enabled: false;
}

export interface DaytonaSandboxConfig extends SandboxConfigBase {
	enabled: true;
	provider: 'daytona';
	id?: string;
	name?: string;
	labels?: Record<string, string>;
	daytonaApiUrl?: string;
	daytonaApiKey?: string;
	image?: CreateSandboxFromImageParams['image'];
	snapshot?: string;
	/**
	 * When true, Daytona auto-deletes the sandbox when it stops (instead of leaving it
	 * stopped). Used for throwaway sandboxes (e.g. eval runs) so they don't accumulate.
	 * Overrides {@link autoDeleteInterval} (Daytona forces it to 0 when ephemeral).
	 */
	ephemeral?: boolean;
	autoStopInterval?: number;
	autoArchiveInterval?: number;
	autoDeleteInterval?: number;
	createTimeoutSeconds?: number;
	getAuthToken?: () => Promise<string>;
	refreshSkewMs?: number;
	logger?: Logger;
}

export interface N8nSandboxConfig extends SandboxConfigBase {
	enabled: true;
	provider: 'n8n-sandbox';
	serviceUrl: string;
	apiKey?: string;
}

export interface E2BSandboxConfig extends SandboxConfigBase {
	enabled: true;
	provider: 'e2b';
	/** Remote E2B sandbox ID. E2B does not support caller-selected sandbox names. */
	id?: string;
	apiKey?: string;
	apiUrl?: string;
	domain?: string;
	sandboxUrl?: string;
	template?: string;
	requestTimeoutMs?: number;
	metadata?: Record<string, string>;
	env?: Record<string, string>;
	secure?: boolean;
	allowInternetAccess?: boolean;
	network?: SandboxNetworkOpts;
	lifecycle?: SandboxLifecycle;
}

export type SandboxConfig =
	| DisabledSandboxConfig
	| DaytonaSandboxConfig
	| N8nSandboxConfig
	| E2BSandboxConfig;

export type SandboxInstance = WorkspaceSandbox;
export type SandboxFilesystem = WorkspaceFilesystem;

export interface CreateSandboxOptions {
	logger?: Logger;
	errorReporter?: ErrorReporter;
}
