import { useEffect, useMemo } from 'octane';
import {
	ApplicationShell,
	type ModuleClientContribution,
} from '@flowdular/client';
import { Alert, EmptyState, Tag } from '@flowdular/ui';
import { cell, createStore, useValue } from 'segment-state';
import { Head } from '@octanejs/seo';
import type { RenderRouteProps } from '@octanejs/vite-plugin';
import type { SessionView } from '../client/api.ts';
import { signalReady } from '../client/state.ts';
import { importDraftModule } from './load-module.ts';
import {
	registerSandboxTranslations,
	restoreSandboxLocale,
	t,
	useTranslation,
} from '../client/i18n.ts';
import '@flowdular/ui/styles';
import '../styles.css';

registerSandboxTranslations();

interface PreviewIdentity {
	readonly accountId: string;
	readonly email: string;
	readonly displayName: string;
	readonly role: string;
	readonly scopes: readonly string[];
	readonly tenantId: string;
	readonly tenants: readonly {
		readonly tenantId: string;
		readonly name: string;
		readonly slug: string;
		readonly role: string;
	}[];
}

interface PreviewPrincipal {
	readonly accountId: string;
	readonly email: string;
	readonly displayName: string;
	readonly role: string;
	readonly scopes: readonly string[];
	readonly tenantId: string;
	readonly tenants: readonly {
		readonly tenantId: string;
		readonly name: string;
		readonly slug: string;
		readonly role: string;
	}[];
}

function previewState() {
	const store = createStore({
		contributions: cell<readonly ModuleClientContribution[]>([]),
		principal: cell<PreviewPrincipal | null>(null),
		status: cell<'loading' | 'ready' | 'empty' | 'failed'>('loading'),
		message: '',
		moduleId: '',
		/* The view the shell opens on: the first navigation entry of the module
   the URL asked for, or of the first module that contributed one. */
		initialView: '',
	});
	return { store, state: store.state };
}

/* The preview runs against the session's own authentication runtime, so the
   draft module sees a real principal, real scopes, and a real CSRF token
   instead of a stub. The credential belongs to one ephemeral database. */
interface PreviewModuleInfo {
	readonly id: string;
	readonly directory: string;
	readonly hasClient: boolean;
	readonly support?: boolean;
}

async function signInPreview(sessionId: string): Promise<{
	readonly principal: PreviewPrincipal;
	readonly csrfToken: string;
	readonly scopes: readonly string[];
	readonly modules: readonly PreviewModuleInfo[];
	readonly error: string | null;
}> {
	document.cookie = `coreloom_preview=${sessionId}; path=/; samesite=strict`;
	const info = await (await fetch(
		'/sandbox/api/sessions/' + encodeURIComponent(sessionId) + '/preview',
		{
			headers: { accept: 'application/json' },
		},
	)).json() as {
		credentials?: { email: string; password: string };
		scopes?: readonly string[];
		modules?: readonly PreviewModuleInfo[];
		error?: string | { message?: string };
	};
	const credentials = info.credentials;
	if (!credentials) {
		throw new Error(typeof info.error === 'string'
			? info.error
			: info.error?.message ?? t('sandbox.preview.sessionUnavailable'));
	}
	const response = await fetch('/api/auth/sign-in', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		credentials: 'same-origin',
		body: JSON.stringify(credentials),
	});
	const session = await response.json() as {
		principal?: PreviewPrincipal;
		csrfToken?: string;
		error?: { message?: string };
	};
	if (!response.ok || !session.principal || !session.csrfToken) {
		throw new Error(session.error?.message ??
			t('sandbox.preview.identityFailed'));
	}
	return {
		principal: session.principal,
		csrfToken: session.csrfToken,
		scopes: info.scopes ?? [],
		modules: info.modules ?? [],
		error: typeof info.error === 'string' ? info.error : null,
	};
}

/* Draft sources are served through a sandbox route that names the session and
   the module directory, never through a host file system path. */
function clientEntry(
	sessionId: string,
	directory: string,
	support = false,
): string {
	return `/${
		support ? 'preview-support' : 'preview-module'
	}/${encodeURIComponent(sessionId)}/${encodeURIComponent(
		directory,
	)}/src/client/index.ts`;
}

function sessionIdFromLocation(url: string): string {
	const segments = new URL(url, 'http://sandbox.local').pathname.split(
		'/',
	).filter(Boolean);
	return segments[0] === 'preview' ? segments[1] ?? '' : '';
}

function identityFor(
	principal: PreviewPrincipal | null,
	contributions: readonly ModuleClientContribution[],
	moduleId: string,
): PreviewIdentity {
	/* The signed-in preview principal decides authority. Its scopes are widened
   only with the surfaces the draft modules declare, so every screen they
   contribute is reachable and nothing else appears. */
	const scopes = new Set<string>([
		'system.workspace.access',
		...(principal?.scopes ?? []),
	]);
	for (const contribution of contributions) {
		for (const item of contribution.navigation ?? []) scopes.add(item.scope);
		for (const widget of contribution.widgets ?? []) scopes.add(widget.scope);
	}
	return {
		accountId: principal?.accountId ?? 'preview-account',
		email: principal?.email ?? 'preview@sandbox.local',
		displayName: principal?.displayName ?? t('sandbox.preview.identityName'),
		role: principal?.role ?? 'owner',
		scopes: [...scopes],
		tenantId: principal?.tenantId ?? 'preview-tenant',
		tenants: principal?.tenants && principal.tenants.length > 0
			? principal.tenants
			: [
					{
						tenantId: 'preview-tenant',
						name: moduleId || t('sandbox.preview.workspace'),
						slug: 'preview',
						role: 'owner',
					},
				],
	};
}

/* Element selection: the parent turns it on, the preview reports what was
   clicked, and the chat attaches it to the next message. */
function installSelection(enabled: boolean): () => void {
	if (!enabled || typeof document === 'undefined') return () => undefined;
	const describe = (element: Element): string => {
		const parts: string[] = [];
		let current: Element | null = element;
		for (let depth = 0; current && depth < 4; depth += 1) {
			const classes = (current.getAttribute('class') ?? '').split(/\s+/).filter(
				Boolean,
			).slice(0, 2).map((value) => '.' + value).join('');
			parts.unshift(current.tagName.toLowerCase() + classes);
			current = current.parentElement;
		}
		return parts.join(' > ');
	};
	const onClick = (event: MouseEvent) => {
		const target = event.target as Element | null;
		if (!target) return;
		event.preventDefault();
		event.stopPropagation();
		const view =
			target.closest('[data-flowdular-view]')?.getAttribute(
				'data-flowdular-view',
			) ??
				'';
		window.parent.postMessage(
			{
				type: 'flowdular:selection',
				label: (target.textContent ?? '').trim().slice(0, 80) ||
					target.tagName.toLowerCase(),
				selector: describe(target),
				view,
				text: (target.textContent ?? '').trim().slice(0, 400),
			},
			'*',
		);
	};
	const onOver = (event: MouseEvent) => {
		const target = event.target as HTMLElement | null;
		if (target) target.style.outline = '2px solid #2563eb';
	};
	const onOut = (event: MouseEvent) => {
		const target = event.target as HTMLElement | null;
		if (target) target.style.outline = '';
	};
	document.addEventListener('click', onClick, true);
	document.addEventListener('mouseover', onOver, true);
	document.addEventListener('mouseout', onOut, true);
	return () => {
		document.removeEventListener('click', onClick, true);
		document.removeEventListener('mouseover', onOver, true);
		document.removeEventListener('mouseout', onOut, true);
	};
}

export function PreviewHost(props?: RenderRouteProps) @{
	const { t } = useTranslation();
	const preview = useMemo(() => previewState(), []);
	const [contributions] = useValue(preview.state.contributions);
	const [principal] = useValue(preview.state.principal);
	const [status, setStatus] = useValue(preview.state.status);
	const [message, setMessage] = useValue(preview.state.message);
	const [moduleId, setModuleId] = useValue(preview.state.moduleId);
	const [initialView] = useValue(preview.state.initialView);

	useEffect(() => {
		restoreSandboxLocale();
		const url = props?.url ?? window.location.href;
		const sessionId = sessionIdFromLocation(url);
		const parameters = new URL(url, 'http://sandbox.local').searchParams;
		const selecting = parameters.has('select');
		/* The workbench opens the preview on one module of the session; every
   module still composes, so this only picks the first screen. */
		const openOn = parameters.get('module') ?? '';
		const teardown = installSelection(selecting);

		void (async () => {
			try {
				const response = await fetch(
					'/sandbox/api/sessions/' + encodeURIComponent(sessionId),
					{ headers: { accept: 'application/json' } },
				);
				const view = await response.json() as
					SessionView & {
						error?: { message?: string };
					};
				if (!response.ok) {
					setMessage(
						view.error?.message ?? t('sandbox.preview.sessionUnavailable'),
					);
					setStatus('failed');
					return;
				}
				setModuleId(view.session.moduleId);
				const identity = await signInPreview(sessionId);
				/* Every draft module with a client entry contributes to the same
   shell, exactly as the platform composes them. */
				const created: ModuleClientContribution[] = [];
				const missing: string[] = [];
				let opening = '';
				for (const module of identity.modules) {
					if (!module.hasClient) continue;
					const loaded = await importDraftModule(
						clientEntry(sessionId, module.directory, module.support),
					);
					if (!loaded.createClientContribution) {
						missing.push(module.id);
						continue;
					}
					const contribution = loaded.createClientContribution({
						csrfToken: identity.csrfToken,
						scopes: [...identity.principal.scopes, ...identity.scopes],
					});
					created.push(contribution);
					const entry = contribution.navigation?.[0]?.viewId ?? '';
					if (
						entry &&
							(!opening || !module.support && !openOn ||
								module.directory === openOn)
					) {
						opening = entry;
					}
				}
				if (created.length === 0) {
					setMessage(
						missing.length > 0
							? missing.join(', ') + t('sandbox.preview.missingExport', {
									modules: missing.join(', '),
								})
							: t('sandbox.preview.noClient'),
					);
					setStatus('empty');
					return;
				}
				preview.store.act((transaction) => {
					transaction.set(preview.state.contributions, created);
					transaction.set(preview.state.principal, identity.principal);
					transaction.set(preview.state.initialView, opening);
				}, 'preview/loaded');
				setStatus('ready');
			} catch (error) {
				setMessage(
					error instanceof Error
						? error.message
						: t('sandbox.preview.loadFailed'),
				);
				setStatus('empty');
			} finally {
				signalReady();
			}
		})();

		return teardown;
	}, []);

	/* The shell registers document metadata, so the preview provides the same
   Head boundary the platform gives it. */
	<Head>
		@if (status === 'ready' && contributions.length > 0) {
			<ApplicationShell
				contributions={contributions}
				identity={identityFor(principal, contributions, moduleId)}
				initialView={initialView || contributions[0]!.navigation?.[0]?.viewId ||
					'overview'}
				onSignOut={() => undefined}
				onSwitchTenant={() => undefined}
			/>
		} @else if (status === 'loading') {
			<div class="ui-view" style="padding: 24px">
				<p class="ui-help">{t('sandbox.preview.loading')}</p>
			</div>
		} @else {
			<div class="ui-view" style="padding: 24px">
				<EmptyState
					icon="flask"
					title={t('sandbox.preview.empty.title')}
					code="src/client/index.ts"
				>
					{message || t('sandbox.preview.empty.description')}
				</EmptyState>
				@if (status === 'failed') {
					<Alert>{message}</Alert>
				} @else {
					<Tag tone="info">{moduleId || t('sandbox.preview.draftModule')}</Tag>
				}
			</div>
		}
	</Head>
}
