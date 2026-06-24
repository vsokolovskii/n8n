import type { EntryInfo, Filesystem as E2BFilesystemHandle } from 'e2b';
import { dirname } from 'node:path/posix';

import type {
	CopyOptions,
	FileContent,
	FileEntry,
	FileStat,
	ListOptions,
	ProviderStatus,
	ReadOptions,
	RemoveOptions,
	WriteOptions,
} from '../types';
import { BaseFilesystem } from './base-filesystem';
import type { E2BSandbox } from '../sandbox/e2b-sandbox';
import { loadE2B } from '../sandbox/lazy-e2b';

function getParentDirectory(path: string): string | null {
	const parent = dirname(path);
	return parent === '.' || parent === '/' ? null : parent;
}

function toArrayBuffer(content: Buffer | Uint8Array): ArrayBuffer {
	const bytes = Buffer.from(content);
	const arrayBuffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(arrayBuffer).set(bytes);
	return arrayBuffer;
}

function toFileContent(content: FileContent): string | ArrayBuffer {
	return typeof content === 'string' ? content : toArrayBuffer(content);
}

function isDirectory(entry: EntryInfo): boolean {
	const { FileType } = loadE2B();
	return entry.type === FileType.DIR;
}

function isE2BFileNotFoundError(error: unknown): boolean {
	const { FileNotFoundError } = loadE2B();
	return error instanceof FileNotFoundError;
}

/** Native agents filesystem adapter backed by the E2B SDK's filesystem API. */
export class E2BFilesystem extends BaseFilesystem {
	readonly id: string;
	readonly name = 'E2BFilesystem';
	readonly provider = 'e2b';
	status: ProviderStatus = 'pending';

	constructor(private readonly sandbox: E2BSandbox) {
		super();
		this.id = `e2b-fs-${sandbox.id}`;
	}

	private async withFiles<T>(op: (files: E2BFilesystemHandle) => Promise<T>): Promise<T> {
		await this.ensureReady();
		return await this.sandbox.withFilesystem(op);
	}

	async readFile(path: string, options?: ReadOptions): Promise<string | Buffer> {
		return await this.withFiles(async (files) => {
			if (options?.encoding) {
				const content = await files.read(path, { format: 'text' });
				return Buffer.from(content, 'utf-8').toString(options.encoding);
			}
			const content = await files.read(path, { format: 'bytes' });
			return Buffer.from(content);
		});
	}

	async writeFile(path: string, content: FileContent, options?: WriteOptions): Promise<void> {
		await this.withFiles(async (files) => {
			if (options?.recursive) {
				const parent = getParentDirectory(path);
				if (parent) await files.makeDir(parent);
			}
			await files.write(path, toFileContent(content));
		});
	}

	async appendFile(path: string, content: FileContent): Promise<void> {
		await this.withFiles(async (files) => {
			let existing: Uint8Array;
			try {
				existing = await files.read(path, { format: 'bytes' });
			} catch (error) {
				if (!isE2BFileNotFoundError(error)) throw error;
				existing = new Uint8Array();
			}
			const appended = Buffer.concat([Buffer.from(existing), Buffer.from(content)]);
			await files.write(path, toArrayBuffer(appended));
		});
	}

	async deleteFile(path: string, options?: RemoveOptions): Promise<void> {
		await this.withFiles(async (files) => {
			try {
				await files.remove(path);
			} catch (error) {
				if (!options?.force || !isE2BFileNotFoundError(error)) throw error;
			}
		});
	}

	async copyFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
		await this.withFiles(async (files) => {
			if (options?.recursive) {
				const parent = getParentDirectory(dest);
				if (parent) await files.makeDir(parent);
			}
			const content = await files.read(src, { format: 'bytes' });
			await files.write(dest, toArrayBuffer(content));
		});
	}

	async moveFile(src: string, dest: string, _options?: CopyOptions): Promise<void> {
		await this.withFiles(async (files) => await files.rename(src, dest));
	}

	async mkdir(path: string, _options?: { recursive?: boolean }): Promise<void> {
		await this.withFiles(async (files) => await files.makeDir(path));
	}

	async rmdir(path: string, options?: RemoveOptions): Promise<void> {
		await this.deleteFile(path, options);
	}

	async readdir(path: string, _options?: ListOptions): Promise<FileEntry[]> {
		return await this.withFiles(async (files) => {
			const entries = await files.list(path);
			return entries.map((entry) => ({
				name: entry.name,
				type: isDirectory(entry) ? 'directory' : 'file',
				size: entry.size,
			}));
		});
	}

	async exists(path: string): Promise<boolean> {
		return await this.withFiles(async (files) => await files.exists(path));
	}

	async stat(path: string): Promise<FileStat> {
		return await this.withFiles(async (files) => {
			const info = await files.getInfo(path);
			const modifiedAt = info.modifiedTime ?? new Date(0);
			return {
				name: info.name,
				path: info.path,
				type: isDirectory(info) ? 'directory' : 'file',
				size: info.size,
				createdAt: modifiedAt,
				modifiedAt,
			};
		});
	}
}
