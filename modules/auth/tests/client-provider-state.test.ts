import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import {
	registerModuleTranslations,
	setActiveLocale,
} from '@flowdular/client/i18n';
import { loadIdentityProviders } from '../src/client/providers/api.ts';
import { providerReadDenied } from '../src/client/providers/state.ts';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import {
	call,
	closeAuthTestDatabases,
	ORIGIN,
	signUpOwner,
	testRuntime,
	type TestRuntime,
} from './helpers.ts';
import { authTestProvider } from './support/database.ts';

const open = new Set<TestRuntime>();

beforeAll(async () => {
	registerModuleTranslations([
		{
			moduleId: 'auth.core',
			translations: { en: translationsEn, pl: translationsPl },
		},
	]);
	await authTestProvider();
}, 60_000);

afterEach(async () => {
	setActiveLocale('en');
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	await Promise.all([...open].map((runtime) => runtime.dispose()));
	open.clear();
});

afterAll(closeAuthTestDatabases);

/** Runs the screen's own fetch against a response the server actually built. */
async function read(served: Response): Promise<unknown> {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => served.clone()),
	);
	return loadIdentityProviders().then(
		() => {
			throw new Error('Expected the read to reject.');
		},
		(error: unknown) => error,
	);
}

describe('AUTH-PROVIDER-TENANT-CRUD provider read failures', () => {
	it('separates a refused read from a broken one, using what the route answers', async () => {
		const runtime = await testRuntime();
		open.add(runtime);
		const owner = await signUpOwner(runtime);
		const member = await runtime.authService.createTenantMember(
			{
				tenantId: owner.tenantId,
				email: 'member@example.com',
				password: 'steady tangerine harbor',
				displayName: 'Mo Member',
				role: 'member',
			},
			{
				accountId: owner.accountId,
				tenantId: owner.tenantId,
				email: 'owner@example.com',
				role: 'owner',
				scopes: [
					...(await runtime.authService.listGrantableScopes(owner.tenantId)),
				],
			},
		);
		expect(member.scopes).not.toContain('auth.providers.read');
		const signedIn = await runtime.authService.signIn({
			email: 'member@example.com',
			password: 'steady tangerine harbor',
		});
		if ('mfaRequired' in signedIn) throw new Error('unexpected challenge');

		const anonymous = await call(
			runtime,
			'/api/auth/providers',
			new Request(`${ORIGIN}/api/auth/providers`),
		);
		expect(anonymous.status).toBe(401);
		const refused = await call(
			runtime,
			'/api/auth/providers',
			new Request(`${ORIGIN}/api/auth/providers`, {
				headers: { cookie: `coreloom_session_dev=${signedIn.token}` },
			}),
		);
		expect(refused.status).toBe(403);

		expect(providerReadDenied(await read(anonymous))).toBe(true);
		expect(providerReadDenied(await read(refused))).toBe(true);

		/* A fault is not a denied screen: the error stays in front of a retry. */
		const broken = await read(
			Response.json(
				{ error: { code: 'INTERNAL', message: 'The request failed.' } },
				{ status: 500 },
			),
		);
		expect(providerReadDenied(broken)).toBe(false);
		expect((broken as Error).message).toBe('The request failed.');
		expect(providerReadDenied(new TypeError('Failed to fetch'))).toBe(false);
	});

	it('names the retry in every locale the module ships', () => {
		expect(
			[translationsEn, translationsPl].map(
				(bundle) => (bundle as Record<string, string>)['common.retry'],
			),
		).toEqual(['Try again', 'Spróbuj ponownie']);
	});
});
