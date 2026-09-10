import type { ModuleManifest } from './index.ts';

export interface ModuleReviewEvidence {
	readonly sourceSha256: string;
	readonly requirements: readonly string[];
	readonly findings: readonly string[];
	readonly checks: readonly {
		name: 'typecheck' | 'test' | 'validate';
		command: string;
		exitCode: 0;
	}[];
}
export interface ModuleSourceFile {
	readonly path: string;
	readonly content: string;
	readonly sha256: string;
}
export interface ModuleArtifact {
	readonly schemaVersion: 1;
	readonly manifest: ModuleManifest;
	readonly files: readonly ModuleSourceFile[];
	readonly review: ModuleReviewEvidence;
}
export interface ModuleRelease {
	readonly manifest: ModuleManifest;
	readonly artifact: string;
	readonly sha256: string;
	readonly sourceCommit: string;
	readonly license: string;
}
export interface ModuleCatalog {
	readonly schemaVersion: 1;
	readonly releases: readonly ModuleRelease[];
}
export interface InstalledModule {
	readonly id: string;
	readonly version: string;
	readonly directory: string;
	readonly sha256: string;
	readonly artifact: string;
	readonly sourceCommit: string;
	readonly files: Readonly<Record<string, string>>;
}
export interface ModuleInstallLock {
	readonly schemaVersion: 1;
	readonly modules: readonly InstalledModule[];
}
