import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/module-auth/server';
import { createAccessRoutes, createAccessRuntime } from './server/index.ts';
import { authDirectory } from './services/auth-directory.ts';
import { accessDataClasses } from './services/data-classes.ts';
import {
	accessListExports,
	EXPORT_LISTS_CAPABILITY,
	type ExportListRegistry,
} from './services/list-exports.ts';

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	const runtime = createAccessRuntime({
		databases: context.databases,
		purpose:
			context.environment.NODE_ENV === 'test'
				? 'test'
				: context.environment.NODE_ENV === 'production'
					? 'runtime'
					: 'preview',
		/* Who holds what is auth.core's to answer. access.core reads it through
		   the runtime the platform composed, per request, and stores none of it. */
		directory: authDirectory(context.auth),
	});
	/* The export runs here, on this module's own lease and under its own tenant
	   transaction; the platform only holds the declaration. */
	context.dataClasses.declare(
		'access.core',
		accessDataClasses(() => runtime.service()),
	);
	/* exports.core is optional, and an optional requirement does not order its
	   provider first, so the registry may not exist yet while this module
	   composes. It is asked for twice, once here and once at start, because the
	   provider registers during composition and seals in its own start hook,
	   which runs after this one whenever it composed after this module. Without
	   exports.core both attempts answer nothing and the screens still work. */
	let registered = false;
	const registerLists = (): void => {
		if (registered) return;
		const lists = context.capabilities.get<ExportListRegistry>(
			EXPORT_LISTS_CAPABILITY,
		);
		if (!lists) return;
		registered = true;
		lists.register(
			'access.core',
			accessListExports(() => runtime.service()),
		);
	};
	registerLists();
	return {
		routes: createAccessRoutes(context.auth, runtime),
		start: () => registerLists(),
		dispose: () => runtime.dispose(),
	};
}
