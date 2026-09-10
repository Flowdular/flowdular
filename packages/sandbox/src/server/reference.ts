import { createRequire } from 'node:module';
import {
	access,
	cp,
	mkdir,
	readFile,
	readdir,
	writeFile,
} from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

async function referenceSource(
	workspaceRoot: string,
	path: string,
): Promise<string> {
	const local = join(workspaceRoot, path);
	try {
		await access(local);
		return local;
	} catch {
		/* Use installed SDK references. */
	}
	try {
		const require = createRequire(join(workspaceRoot, 'platform/package.json'));
		return join(dirname(require.resolve('@flowdular/sdk/package.json')), path);
	} catch {
		return local;
	}
}

/* A coding agent may only read inside its session workspace. Without the
   platform contracts it would either invent an architecture or stop, so every
   session gets a read-only copy of the contracts it must implement against and
   one complete example module. */
const REFERENCE_SOURCES: readonly {
	readonly from: string;
	readonly to: string;
}[] = [
	{ from: 'packages/server/src', to: 'reference/packages/server/src' },
	{
		from: 'packages/client/src/contributions.ts',
		to: 'reference/packages/client/contributions.ts',
	},
	{
		from: 'packages/client/src/state.ts',
		to: 'reference/packages/client/state.ts',
	},
	{
		from: 'packages/contracts/src/index.ts',
		to: 'reference/packages/contracts/index.ts',
	},
	{
		from: 'packages/contracts/schemas',
		to: 'reference/packages/contracts/schemas',
	},
	{ from: 'packages/ui/src/index.ts', to: 'reference/packages/ui/index.ts' },
	{
		from: 'packages/ui/src/components',
		to: 'reference/packages/ui/components',
	},
	{
		from: 'packages/ui/src/styles/components.css',
		to: 'reference/packages/ui/components.css',
	},
	/* Outside a modules/ path, so the workspace module walker never mistakes
	   the example for a real module of this session. */
	{ from: '.ai/references/catalog', to: 'reference/example-module' },
	{ from: 'modules/profile', to: 'reference/adapter-module' },
	{ from: 'modules/auth/src/index.ts', to: 'reference/auth-core/index.ts' },
	{
		from: 'modules/auth/src/acl/scopes.ts',
		to: 'reference/auth-core/scopes.ts',
	},
	{
		from: 'modules/auth/src/domain/types.ts',
		to: 'reference/auth-core/types.ts',
	},
	{
		from: 'modules/auth/src/server/index.ts',
		to: 'reference/auth-core/server.ts',
	},
	{
		from: 'modules/auth/src/server/composition.ts',
		to: 'reference/auth-core/composition.ts',
	},
	{
		from: 'modules/auth/src/services/auth-service.ts',
		to: 'reference/auth-core/auth-service.ts',
	},
	{ from: 'AGENTS.md', to: 'reference/AGENTS.md' },
	{ from: 'docs/design-system.md', to: 'reference/design-system.md' },
	{ from: 'docs/agent-contract.md', to: 'reference/agent-contract.md' },
	{ from: '.ai/skills', to: 'reference/skills' },
];

export const SKILLS_DIRECTORY = '.ai/skills';

const EXCLUDED = new Set(['node_modules', 'dist', '.turbo']);

function readme(skills: readonly string[]): string {
	return `# Reference

Read-only copies of the platform contracts this session must implement against.
Never edit anything in this directory: it is not part of the module and it is
not ejected.

- packages/server: defineEndpoint, HTTP helpers, and the endpoint identity contract.
- packages/client: the client contribution contract (createClientContribution, ModuleClientContext), shell slots, and shell state.
- packages/contracts: module manifest, spec, and blueprint schemas.
- packages/ui: every shared primitive and the ui-* class list.
- example-module: a complete module, from ACL to client view, including src/platform.ts. Follow its shape.
- adapter-module: the same shape on the @flowdular/database provider contract, with an async repository, dialect-explicit migrations and a lease-owning runtime. Follow it when the module stores data.
- auth-core: the public surface of auth.core, including its scopes, the PlatformServerContext composition contract, and its service API.
- AGENTS.md and design-system.md: the workspace rules that gates enforce.
- agent-contract.md: detailed lookup reference, not required reading.
- skills: read only the Task skill named in your Session instruction. Other files are available for later tasks, not for preloading.

## Skills

${skills.length > 0 ? skills.map((skill) => `- skills/${skill}/SKILL.md`).join('\n') : '- none available in this workspace'}
`;
}

/* Skill names are the directories under .ai/skills that carry a SKILL.md. */
export async function listSkills(
	workspaceRoot: string,
): Promise<readonly string[]> {
	let entries: readonly string[];
	try {
		entries = await readdir(
			await referenceSource(workspaceRoot, SKILLS_DIRECTORY),
		);
	} catch {
		return [];
	}
	const skills: string[] = [];
	for (const entry of [...entries].sort()) {
		try {
			await readFile(
				await referenceSource(
					workspaceRoot,
					join(SKILLS_DIRECTORY, entry, 'SKILL.md'),
				),
			);
			skills.push(entry);
		} catch {
			continue;
		}
	}
	return skills;
}

export async function materializeReference(
	workspaceRoot: string,
	sessionWorkspace: string,
): Promise<readonly string[]> {
	for (const source of REFERENCE_SOURCES) {
		const target = join(sessionWorkspace, source.to);
		await mkdir(dirname(target), { recursive: true });
		const from = await referenceSource(workspaceRoot, source.from);
		await cp(from, target, {
			recursive: true,
			filter: (path) =>
				!relative(from, path)
					.split('/')
					.some((segment) => EXCLUDED.has(segment)),
		}).catch(() => undefined);
	}
	const skills = await listSkills(workspaceRoot);
	await writeFile(
		join(sessionWorkspace, 'reference/README.md'),
		readme(skills),
		'utf8',
	);
	return skills;
}

/* Local coding agents auto-load a file from the working directory: claude
   reads CLAUDE.md, codex reads AGENTS.md. Neither is the role instruction,
   which the driver passes explicitly; they only point at the reference. */
export async function writeAgentPointer(
	sessionWorkspace: string,
	fileName: 'CLAUDE.md' | 'AGENTS.md',
	roleName: string,
	skill?: string | null,
): Promise<void> {
	await writeFile(
		join(sessionWorkspace, fileName),
		[
			'# Sandbox session workspace',
			'',
			`You work here as ${roleName}. The role instruction you were started with is authoritative.`,
			'',
			skill
				? `- Read only reference/skills/${skill}/SKILL.md for this task. Do not load other skills or the whole reference catalog.`
				: '- No matching task skill is installed. Do not load unrelated skills.',
			'- Write only inside your module directory under modules/, in the paths the instruction allows. Everything under reference/ is read-only.',
			'- End your final message with the HANDOFF line the instruction describes.',
			'',
		].join('\n'),
		'utf8',
	);
}

/* The module registry validates dependencies, so the session workspace carries
   the manifest of every enabled module. Only the draft modules have sources. */
export async function materializeModuleGraph(
	workspaceRoot: string,
	sessionWorkspace: string,
	draftModuleIds: readonly string[],
): Promise<readonly string[]> {
	const drafts = new Set(draftModuleIds);
	const enabled: string[] = [];
	let entries: readonly string[] = [];
	try {
		entries = await readdir(join(workspaceRoot, 'modules'));
	} catch {
		return enabled;
	}
	for (const entry of entries) {
		const manifestPath = join(workspaceRoot, 'modules', entry, 'module.json');
		let manifest: { id?: string; cli?: unknown };
		try {
			manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
				id?: string;
			};
		} catch {
			continue;
		}
		if (!manifest.id || drafts.has(manifest.id)) continue;
		const target = join(sessionWorkspace, 'modules', entry, 'module.json');
		await mkdir(dirname(target), { recursive: true });
		/* Only the dependency graph travels into a session. A CLI declaration
		   would point at command files this workspace does not carry, so the
		   capability goes with it. */
		const { cli: _cli, ...rest } = manifest as Record<string, unknown>;
		const graphManifest = {
			...rest,
			capabilities: (
				(rest.capabilities as readonly string[] | undefined) ?? []
			).filter((capability) => capability !== 'cli'),
		};
		await writeFile(
			target,
			`${JSON.stringify(graphManifest, null, '\t')}\n`,
			'utf8',
		);
		enabled.push(manifest.id);
	}
	return enabled;
}
