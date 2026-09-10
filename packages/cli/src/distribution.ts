/** Release tooling API. Host-only; never grant installation to sandbox agents. */
export {
	packModule,
	readModuleSource,
	sourceDigest,
	hashBytes,
	validateModuleArtifact,
} from './module-artifact.ts';
export { loadModuleCatalog, resolveModuleReleases } from './module-catalog.ts';
export { installModule, validateInstalledModules } from './module-install.ts';
export { enableModule, syncPlatformModules } from './module-sync.ts';
