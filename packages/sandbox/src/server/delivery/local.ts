import { sessionPaths } from '../sessions.ts';
import {
	GATES,
	assertEjectCapability,
	countDeliveredFiles,
	planSessionModules,
} from './plan.ts';
import {
	buildWorkspace,
	createStepRecorder,
	enableModule,
	installWorkspace,
	runDeliveryGates,
	stageModules,
	syncModuleScopes,
	verifyPlatform,
} from './steps.ts';
import type { DeliveryTarget } from './types.ts';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function isLocalPlatform(platformUrl: string): boolean {
	try {
		return LOOPBACK_HOSTS.has(new URL(platformUrl).hostname);
	} catch {
		return false;
	}
}

/* Today's delivery: the module lands in modules/ of this workspace and joins
   the platform through the CLI capabilities a human would run. */
export function createLocalDeliveryTarget(): DeliveryTarget {
	return {
		id: 'local',

		available: async () => ({ available: true, reason: null }),

		plan: async (context) => {
			assertEjectCapability(context);
			const modules = await planSessionModules(context);
			const primary = modules[0]!;
			const platformLocal = isLocalPlatform(context.platformUrl);
			return {
				target: 'workspace',
				deliveredBy: 'local',
				moduleId: primary.id,
				targetPath: primary.targetPath,
				files: primary.files,
				overwrites: primary.overwrites,
				removes: primary.removes,
				newPackages: primary.newPackages,
				enable: primary.enable,
				modules,
				changedFiles: countDeliveredFiles(modules),
				gates: [...GATES],
				platformLocal,
				restartRequired: true,
				notes: [
					platformLocal
						? 'The connected application runs on this machine from this workspace. Restart it after the delivery so it loads the new composition and runs the new migrations.'
						: 'The connected application runs elsewhere. Deploy this workspace for the change to reach it; the sync-scopes step only updated the local database.',
				],
				applied: false,
			};
		},

		apply: async (context, plan, emit) => {
			assertEjectCapability(context);
			const paths = sessionPaths(
				context.workspaceRoot,
				context.session.id,
				context.session.moduleSuffix,
			);
			const { steps, record } = createStepRecorder(emit);
			const gates = await runDeliveryGates(context, plan.gates, emit);
			const { copied, removed } = await stageModules(
				paths,
				context.workspaceRoot,
				plan.modules,
				emit,
			);

			emit('install.started', {});
			record(
				'install',
				await installWorkspace(context.commands, context.workspaceRoot),
			);

			let enabled = false;
			for (const module of plan.modules) {
				if (!module.enable) continue;
				emit('enable.started', { moduleId: module.id });
				record(
					'enable',
					await enableModule(
						context.commands,
						context.workspaceRoot,
						module.id,
					),
				);
				enabled = true;
			}

			for (const module of plan.modules) {
				emit('scopes.started', { moduleId: module.id });
				record(
					'scopes',
					await syncModuleScopes(
						context.commands,
						context.workspaceRoot,
						module.id,
					),
				);
			}

			/* The modules now live in the platform composition, so the platform
			   itself has to still typecheck. */
			emit('verify.started', {});
			record(
				'verify',
				await verifyPlatform(context.commands, context.workspaceRoot),
			);

			if (context.build === true) {
				emit('build.started', {});
				record(
					'build',
					await buildWorkspace(context.commands, context.workspaceRoot),
				);
			}

			if (plan.restartRequired) {
				emit('restart.required', {
					platformLocal: plan.platformLocal,
					note: plan.notes[0] ?? '',
				});
			}

			return {
				moduleId: plan.moduleId,
				targetPath: plan.targetPath,
				files: copied,
				removed,
				enabled,
				gates,
				steps,
				restartRequired: plan.restartRequired,
			};
		},
	};
}
