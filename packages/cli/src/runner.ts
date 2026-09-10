import { RegistryError } from '@flowdular/kernel';
import { loadModuleCatalog } from './module-catalog.ts';
import {
	installModule,
	validateInstalledModules,
	recoverModuleInstall,
} from './module-install.ts';
import { ModuleDistributionError } from './module-artifact.ts';
import { findModuleFiles } from './module-files.ts';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
	failure,
	success,
	type CapabilityDescriptor,
	type CommandEnvelope,
} from '@flowdular/cli-protocol';
import {
	databaseProviderConfigFromEnvironment,
	type ConfiguredDatabaseProvider,
} from '@flowdular/database';
import { capabilities, capability as coreCapability } from './capabilities.ts';
import { createCliDatabaseProvider, databaseReset } from './database.ts';
import { migrationScaffold } from './migration-new.ts';
import { runDoctor } from './doctor.ts';
import {
	loadCliCommand,
	loadCliExtensions,
	type LoadedCliCommand,
} from './extensions.ts';
import {
	migrationApply,
	migrationStatus,
	migrationVerify,
} from './migration.ts';
import { scaffoldModule } from './module-scaffold.ts';
import { migrateLegacyState } from './state-migration.ts';
import {
	disableModule,
	enableModule,
	syncPlatformModules,
} from './module-sync.ts';
import { validateModules } from './module-validate.ts';
import {
	findNamedFiles,
	listPlatformSpecs,
	validateBlueprint,
	validateFile,
	validators,
} from './validation.ts';
import {
	findWorkspace,
	resolveExistingInside,
	type Workspace,
} from './workspace.ts';
import type { ParsedArguments } from './arguments.ts';
import { stringFlag } from './arguments.ts';

function relativeReports(
	root: string,
	reports: readonly { file: string; valid: boolean; issues: unknown }[],
) {
	return reports.map((report) => ({
		...report,
		file: relative(root, report.file),
	}));
}

/* The approval gates of packages/cli/src/capabilities.ts and every module
   catalog, in the order .ai/policies/capabilities.yaml documents. The spec gate
   sits between the two halves because only it needs the workspace. */
function environmentRefusal(
	descriptor: CapabilityDescriptor,
): CommandEnvelope | undefined {
	if (descriptor.risk === 'external') {
		return failure(
			'APPROVAL_VERIFIER_REQUIRED',
			`Capability "${descriptor.id}" is disabled until a signed approval verifier is configured.`,
		);
	}
	if (descriptor.risk === 'destructive' && !descriptor.localOnly) {
		return failure(
			'APPROVAL_VERIFIER_REQUIRED',
			`Destructive capability "${descriptor.id}" is disabled until a signed approval verifier is configured.`,
		);
	}
	const environment =
		process.env.FD_ENV ?? process.env.NODE_ENV ?? 'development';
	if (
		descriptor.localOnly &&
		environment !== 'development' &&
		environment !== 'test'
	) {
		return failure(
			'LOCAL_ONLY_CAPABILITY',
			`Capability "${descriptor.id}" cannot run in environment "${environment}".`,
		);
	}
	return undefined;
}

function writeRefusal(
	descriptor: CapabilityDescriptor,
	arguments_: ParsedArguments,
): CommandEnvelope | undefined {
	const apply = arguments_.flags.has('apply');
	if (descriptor.risk === 'destructive' && apply) {
		const confirmation = stringFlag(arguments_, 'confirm');
		if (!descriptor.confirmation || confirmation !== descriptor.confirmation) {
			return failure(
				'CONFIRMATION_REQUIRED',
				`Pass --confirm ${descriptor.confirmation ?? '<token>'} with --apply.`,
			);
		}
	}
	if (descriptor.risk !== 'read' && !descriptor.supportsDryRun && !apply) {
		return failure(
			'EXPLICIT_APPLY_REQUIRED',
			'Pass --apply to execute this capability.',
		);
	}
	return undefined;
}

async function runExtensionCommand(
	workspace: Workspace,
	extension: LoadedCliCommand,
	arguments_: ParsedArguments,
): Promise<CommandEnvelope> {
	const descriptor = extension.command.capability;
	const refused = environmentRefusal(descriptor);
	if (refused) return refused;
	if (descriptor.requiresApprovedSpec) {
		const specFlag = stringFlag(arguments_, 'spec');
		if (!specFlag) {
			return failure(
				'APPROVED_SPEC_REQUIRED',
				'--spec <path> is required for this capability.',
			);
		}
		const specPath = await resolveExistingInside(workspace.root, specFlag);
		const report = await validateFile(specPath, validators.moduleSpec);
		if (!report.valid) {
			return failure(
				'SPEC_VALIDATION_FAILED',
				'The capability spec is invalid.',
				{ report },
			);
		}
		const spec = parseYaml(await readFile(specPath, 'utf8')) as {
			status?: string;
		};
		if (spec.status !== 'approved') {
			return failure(
				'SPEC_NOT_APPROVED',
				'The capability spec must be approved.',
			);
		}
	}
	const writeRefused = writeRefusal(descriptor, arguments_);
	if (writeRefused) return writeRefused;
	const apply = arguments_.flags.has('apply');
	const command = await loadCliCommand(extension);
	const invokedByCapability =
		arguments_.positionals[0] === 'capability' &&
		arguments_.positionals[1] === 'run';
	let databases: ConfiguredDatabaseProvider | undefined;
	try {
		const result = await command.execute({
			workspaceRoot: workspace.root,
			moduleRoot: extension.moduleRoot,
			apply,
			flags: arguments_.flags,
			arguments: arguments_.positionals.slice(
				invokedByCapability ? 3 : extension.command.path.length,
			),
			/* Built on first read, so a command that touches no database starts no
			   embedded PostgreSQL and opens no pool. The runner owns it for the
			   length of the command: an extension releases the leases it takes and
			   never disposes the provider. */
			get databases() {
				databases ??= createCliDatabaseProvider(
					databaseProviderConfigFromEnvironment(process.env, workspace.root),
				);
				return databases;
			},
		});
		return success(result.data, {
			evidence: result.evidence ?? [],
			warnings: [
				...(result.warnings ?? []),
				...(!apply && descriptor.risk !== 'read'
					? ['Dry run only. No writes were authorized.']
					: []),
			],
		});
	} finally {
		await databases?.dispose();
	}
}

export async function runCommand(
	arguments_: ParsedArguments,
): Promise<CommandEnvelope> {
	try {
		const rootFlag = stringFlag(arguments_, 'root');
		const workspace = await findWorkspace(rootFlag ?? process.cwd());
		const extensionCommands = await loadCliExtensions(workspace);
		const allCapabilities = [
			...capabilities,
			...extensionCommands.map((entry) => entry.command.capability),
		];
		const [group, action, target] = arguments_.positionals;

		if (!group || group === 'help' || arguments_.flags.has('help')) {
			return success({
				usage:
					'flowdular [--root <workspace>] [--json] <doctor|capability|spec|blueprint|module|migration|database|setup> [action] [options]',
				commands: [
					'doctor',
					'capability list|describe <id>|run <id>',
					'spec validate [--all]',
					'blueprint list|validate --all',
					'module search [query]|info <id>|install <id[@version]> [--apply]|update <id[@version]> [--apply]|recover [--apply] [--registry <local-index>] ',
					'module list|validate [--locked]|sync [--apply]|enable <id> [--apply]|disable <id> [--apply]|new <id> --spec <path> [--apply]',
					'migration status [--module <id>]|apply --module <id> [--apply]|verify|new <name> --module <id> [--apply]',
					'database reset [--module <id>] [--apply --confirm reset-database]',
					'setup check|quick [--apply --confirm reset-local-auth]|migrate-state [--apply --confirm migrate-legacy-state]',
					...extensionCommands.map((entry) => entry.command.path.join(' ')),
				],
				options: [
					'--root <workspace>: operate on another workspace (defaults to the nearest flowdular.json above the current directory)',
					'--json: print the machine-readable envelope',
					'--apply: perform writes; every write command is a dry run without it',
					'--all: with "spec validate", also validate the platform specs under the configured specs root',
				],
			});
		}

		if (group === 'setup' && action === 'quick') {
			const greenfield = extensionCommands.find(
				(entry) => entry.command.capability.id === 'auth.greenfield.reset',
			);
			return greenfield
				? await runExtensionCommand(workspace, greenfield, arguments_)
				: failure(
						'AUTH_MODULE_REQUIRED',
						'Quick setup requires the enabled auth.core module.',
					);
		}

		if (group === 'setup' && action === 'migrate-state') {
			const descriptor = coreCapability('workspace.state.migrate')!;
			const refused =
				environmentRefusal(descriptor) ?? writeRefusal(descriptor, arguments_);
			if (refused) return refused;
			return migrateLegacyState(workspace, arguments_.flags.has('apply'));
		}

		if (
			group === 'doctor' ||
			(group === 'setup' && (!action || action === 'check'))
		) {
			const checks = await runDoctor(workspace);
			const failed = checks.filter((check) => check.status === 'fail');
			return failed.length === 0
				? success(
						{ status: 'healthy', checks },
						{ evidence: checks.flatMap((check) => check.evidence ?? []) },
					)
				: failure(
						'DOCTOR_FAILED',
						`${failed.length} workspace check(s) failed.`,
						{ checks },
					);
		}

		if (group === 'capability') {
			if (action === 'list') return success({ capabilities: allCapabilities });
			if (action === 'describe' && target) {
				const descriptor =
					coreCapability(target) ??
					extensionCommands.find(
						(entry) => entry.command.capability.id === target,
					)?.command.capability;
				return descriptor
					? success({ capability: descriptor })
					: failure('CAPABILITY_NOT_FOUND', `Unknown capability: ${target}`);
			}
			if (action === 'run' && target) {
				const extension = extensionCommands.find(
					(entry) => entry.command.capability.id === target,
				);
				if (extension)
					return await runExtensionCommand(workspace, extension, arguments_);
				if (target === 'workspace.doctor') {
					const checks = await runDoctor(workspace);
					return success({ checks });
				}
				const aliases: Record<string, readonly string[]> = {
					'spec.validate': ['spec', 'validate'],
					'blueprint.validate': ['blueprint', 'validate'],
					'module.validate': ['module', 'validate'],
					'migration.status': ['migration', 'status'],
					'migration.verify': ['migration', 'verify'],
					'migration.apply.local': ['migration', 'apply'],
					'workspace.state.migrate': ['setup', 'migrate-state'],
					'database.reset.local': ['database', 'reset'],
				};
				const alias = aliases[target];
				if (alias)
					return runCommand({
						...arguments_,
						positionals: alias,
						flags: new Map(arguments_.flags).set('all', true),
					});
				if (target === 'module.create') {
					return failure(
						'INPUT_REQUIRED',
						'Use module new <id> --spec <path> [--apply].',
					);
				}
				return failure(
					'CAPABILITY_NOT_FOUND',
					`Unknown or non-runnable capability: ${target}`,
				);
			}
			return failure(
				'USAGE_ERROR',
				'Use capability list, describe <id>, or run <id>.',
			);
		}

		if (group === 'spec' && action === 'validate') {
			const files = (
				await findNamedFiles(workspace.root, 'module.yaml')
			).filter((file) => file.includes('/modules/'));
			const reports = await Promise.all(
				files.map((file) => validateFile(file, validators.moduleSpec)),
			);
			if (arguments_.flags.has('all')) {
				const platformRoot =
					(workspace.config.specs as { platformRoot?: string } | undefined)
						?.platformRoot ?? 'specs';
				const platformSpecs = await listPlatformSpecs(
					join(workspace.root, platformRoot),
				);
				reports.push(
					...(await Promise.all(
						platformSpecs.map((file) =>
							validateFile(file, validators.platformSpec),
						),
					)),
				);
			}
			const data = relativeReports(workspace.root, reports);
			return reports.every((report) => report.valid)
				? success(
						{ valid: true, reports: data },
						{ evidence: data.map((report) => report.file) },
					)
				: failure(
						'SPEC_VALIDATION_FAILED',
						'One or more specifications are invalid.',
						{ reports: data },
					);
		}

		if (group === 'blueprint' && action === 'list') {
			const files = await findNamedFiles(workspace.root, 'blueprint.json');
			return success({
				blueprints: files.map((file) => relative(workspace.root, file)),
			});
		}

		if (group === 'blueprint' && action === 'validate') {
			const files = await findNamedFiles(workspace.root, 'blueprint.json');
			const reports = await Promise.all(files.map(validateBlueprint));
			const data = relativeReports(workspace.root, reports);
			return reports.every((report) => report.valid)
				? success(
						{ valid: true, reports: data },
						{ evidence: data.map((report) => report.file) },
					)
				: failure(
						'BLUEPRINT_VALIDATION_FAILED',
						'One or more blueprints are invalid.',
						{ reports: data },
					);
		}

		if (group === 'database') {
			if (action !== 'reset') {
				return failure(
					'USAGE_ERROR',
					'Use database reset [--module <id>] [--apply --confirm reset-database].',
				);
			}
			const descriptor = coreCapability('database.reset.local')!;
			const refused =
				environmentRefusal(descriptor) ?? writeRefusal(descriptor, arguments_);
			if (refused) return refused;
			return databaseReset(
				workspace,
				stringFlag(arguments_, 'module'),
				arguments_.flags.has('apply'),
			);
		}

		if (group === 'migration') {
			const moduleFlag = stringFlag(arguments_, 'module');
			if (action === 'new') {
				if (!moduleFlag || !target) {
					return failure(
						'INPUT_REQUIRED',
						'Use migration new <name> --module <id> [--apply].',
					);
				}
				const descriptor = coreCapability('migration.scaffold')!;
				const refused = writeRefusal(descriptor, arguments_);
				if (refused) return refused;
				return migrationScaffold(
					workspace,
					moduleFlag,
					target,
					arguments_.flags.has('apply'),
				);
			}
			if (action === 'status') {
				return migrationStatus(workspace, moduleFlag);
			}
			if (action === 'verify') return migrationVerify(workspace);
			if (action === 'apply') {
				if (!moduleFlag) {
					return failure(
						'INPUT_REQUIRED',
						'--module <id> is required; migrations are applied one module at a time.',
					);
				}
				const descriptor = coreCapability('migration.apply.local')!;
				const refused =
					environmentRefusal(descriptor) ??
					writeRefusal(descriptor, arguments_);
				if (refused) return refused;
				return migrationApply(
					workspace,
					moduleFlag,
					arguments_.flags.has('apply'),
				);
			}
			return failure(
				'USAGE_ERROR',
				'Use migration status, migration apply --module <id>, migration verify, or migration new <name> --module <id>.',
			);
		}

		if (group === 'module' && (action === 'search' || action === 'info')) {
			const source = stringFlag(arguments_, 'source');
			if (source && source !== 'official')
				return failure('USAGE_ERROR', 'Only --source official is supported.');
			const { catalog } = await loadModuleCatalog(
				stringFlag(arguments_, 'registry'),
			);
			const releases = catalog.releases.filter((release) =>
				action === 'info'
					? release.manifest.id === target
					: !target || release.manifest.id.includes(target),
			);
			if (action === 'info' && !releases.length)
				return failure(
					'MODULE_NOT_FOUND',
					`No official module ${target ?? ''}.`,
				);
			return success({ releases });
		}
		if (group === 'module' && (action === 'install' || action === 'update')) {
			if (!target)
				return failure(
					'USAGE_ERROR',
					`Use module ${action} <id[@version]> [--apply].`,
				);
			const registry = stringFlag(arguments_, 'registry');
			const report = await installModule(workspace, {
				target,
				apply: arguments_.flags.has('apply'),
				update: action === 'update',
				...(registry ? { registry } : {}),
			});
			return success(report, {
				warnings: report.activationRequired
					? [
							'Source installation does not activate modules. Review the source, then use module enable <id> --apply to link packages and enable the module.',
						]
					: [],
			});
		}
		if (group === 'module' && action === 'recover')
			return success(
				await recoverModuleInstall(workspace, arguments_.flags.has('apply')),
			);
		if (group === 'module' && action === 'list') {
			const files = await findModuleFiles(workspace);
			return success({
				modules: files.map((file) => relative(workspace.root, file)),
			});
		}

		if (group === 'module' && action === 'validate') {
			if (arguments_.flags.has('locked'))
				await validateInstalledModules(workspace);
			const moduleFlag = stringFlag(arguments_, 'module');
			return validateModules(
				workspace,
				moduleFlag
					? {
							modules: moduleFlag
								.split(',')
								.map((entry) => entry.trim())
								.filter(Boolean),
						}
					: {},
			);
		}

		if (group === 'module' && action === 'sync') {
			const report = await syncPlatformModules(
				workspace,
				arguments_.flags.has('apply'),
			);
			return success(report, {
				evidence: report.files.map((file) => file.path),
				warnings: report.applied
					? []
					: ['Dry run only. Pass --apply to write the generated composition.'],
			});
		}

		if (group === 'module' && action === 'enable' && target) {
			const apply = arguments_.flags.has('apply');
			const report = await enableModule(workspace, target, apply);
			const warnings = [
				...(apply
					? []
					: [
							'Dry run only. Pass --apply to enable the module and its dependencies, regenerate the composition, and grant their scopes.',
						]),
				...(report.installed
					? []
					: [
							'Run "pnpm install" to link the module package before starting the app.',
						]),
			];
			/* A module brings its own scopes. Without this grant it is enabled and
			   invisible, because no owner holds the permission its navigation needs. */
			let scopes: unknown;
			const scopeGrants: unknown[] = [];
			if (apply) {
				/* Enabling a module can enable auth.core as part of its dependency
				   closure, so discover extensions again against the resulting config. */
				const enabledWorkspace: Workspace = {
					...workspace,
					config: {
						...workspace.config,
						modules: {
							...((workspace.config.modules as
								| Record<string, unknown>
								| undefined) ?? {}),
							enabled: [...report.enabled],
						},
					},
				};
				const enabledExtensions = await loadCliExtensions(enabledWorkspace);
				const scopeSync = enabledExtensions.find(
					(entry) => entry.command.capability.id === 'auth.scopes.sync',
				);
				if (!scopeSync) {
					warnings.push(
						'auth.core is not enabled, so module scopes were not granted. Run "flowdular auth sync-scopes --module <id> --apply" once it is.',
					);
				} else {
					const modulesToGrant = [
						...report.newlyEnabled,
						...(report.newlyEnabled.includes(target) ? [] : [target]),
					];
					for (const moduleId of modulesToGrant) {
						const granted = await runExtensionCommand(
							enabledWorkspace,
							scopeSync,
							{
								positionals: ['auth', 'sync-scopes'],
								flags: new Map<string, string | boolean>([
									['module', moduleId],
									['apply', true],
								]),
							},
						);
						if (!granted.ok) {
							return failure(
								'MODULE_SCOPES_SYNC_FAILED',
								`Module ${moduleId} is enabled but its scopes were not granted: ${granted.error?.message ?? 'unknown error'}`,
								{ report, moduleId, error: granted.error },
							);
						}
						scopeGrants.push(granted.data);
						warnings.push(...granted.warnings);
						if (moduleId === target) scopes = granted.data;
					}
				}
			}
			return success(
				{
					...report,
					...(scopes === undefined ? {} : { scopes }),
					...(scopeGrants.length === 0 ? {} : { scopeGrants }),
				},
				{
					evidence: [
						'flowdular.json',
						'platform/package.json',
						...report.files.map((file) => file.path),
					],
					warnings,
				},
			);
		}

		if (group === 'module' && action === 'disable' && target) {
			const report = await disableModule(
				workspace,
				target,
				arguments_.flags.has('apply'),
			);
			return success(report, {
				evidence: ['flowdular.json', ...report.files.map((file) => file.path)],
				warnings: report.applied
					? []
					: [
							'Dry run only. Pass --apply to disable the module and regenerate the composition.',
						],
			});
		}

		if (group === 'module' && action === 'new' && target) {
			const specPath = stringFlag(arguments_, 'spec');
			if (!specPath)
				return failure('INPUT_REQUIRED', '--spec <path> is required.');
			const result = await scaffoldModule(workspace, {
				id: target,
				specPath,
				apply: arguments_.flags.has('apply'),
			});
			return success(result, {
				evidence: result.files,
				warnings: [
					...(result.applied
						? []
						: ['Dry run only. Pass --apply to create these files.']),
					...(result.applied && !result.formatted
						? [
								'Prettier was not found in the workspace; run "pnpm format" before the format gate.',
							]
						: []),
				],
			});
		}

		const extension = extensionCommands
			.filter((entry) =>
				entry.command.path.every(
					(part, index) => arguments_.positionals[index] === part,
				),
			)
			.sort(
				(left, right) => right.command.path.length - left.command.path.length,
			)[0];
		if (extension)
			return await runExtensionCommand(workspace, extension, arguments_);

		return failure(
			'USAGE_ERROR',
			`Unknown command: ${arguments_.positionals.join(' ')}`,
		);
	} catch (error) {
		return failure(
			error instanceof ModuleDistributionError || error instanceof RegistryError
				? error.code
				: 'COMMAND_FAILED',
			error instanceof Error ? error.message : String(error),
		);
	}
}
