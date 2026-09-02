import {
	ApplicationShell,
	activeLocale,
	shellLocationFromUrl,
	t,
} from '@coreloom/client';
import {
	AuthenticationCore,
	authScreenFromUrl,
} from '@coreloom/module-auth/client';
import type { AuthPrincipal } from '@coreloom/module-auth';
import { Head, Seo } from '@octanejs/seo';
import type { RenderRouteProps } from '@octanejs/vite-plugin';
import { createModuleClientContributions } from './generated/modules.client.ts';
import { applicationInitialUrl } from './routing.ts';
import './styles.css';

interface AuthenticatedAppProps {
	initialUrl: string;
	principal: AuthPrincipal;
	csrfToken: string;
	signOut: () => Promise<void>;
	switchTenant: (tenantId: string) => Promise<void>;
}

function AuthenticatedApp(props: AuthenticatedAppProps) @{
	const canAccessWorkspace = props.principal.scopes.includes(
		'system.workspace.access',
	);
	<div>
		@if (canAccessWorkspace) {
			<ApplicationShell
				initialView={shellLocationFromUrl(
					props.initialUrl,
					props.principal.tenants.map((tenant) => tenant.slug),
				).view}
				contributions={createModuleClientContributions({
					csrfToken: props.csrfToken,
					scopes: props.principal.scopes,
					locale: activeLocale(),
					t,
				})}
				identity={props.principal}
				onSignOut={props.signOut}
				onSwitchTenant={props.switchTenant}
			/>
		} @else {
			<main class="access-denied">
				<span>403</span>
				<h1>{t('shell.accessDenied.title')}</h1>
				<p>{t('shell.accessDenied.description')}</p>
				<button
					class="ui-btn ui-btn--primary"
					type="button"
					onClick={() => void props.signOut()}
				>{t('shell.account.signOut')}</button>
			</main>
		}
	</div>
}

export function App(props?: RenderRouteProps) @{
	const initialUrl =
		props?.url ?? (typeof window === 'undefined' ? '/' : window.location.href);
	<Head>
		<Seo
			title={t('shell.workspace.title')}
			titleTemplate="%s · Coreloom"
			description={t('shell.seo.description')}
			robots={{ index: false, follow: false, noarchive: true }}
			openGraph={{
				type: 'website',
				siteName: 'Coreloom',
				images: [
					{
						url: '/og.png',
						width: 1200,
						height: 630,
						alt: t('shell.seo.imageAlt'),
					},
				],
			}}
			twitter={{ card: 'summary_large_image', image: '/og.png' }}
		/>
		<AuthenticationCore
			initialScreen={authScreenFromUrl(initialUrl)}
			renderAuthenticated={(principal, controls) =>
				<AuthenticatedApp
					initialUrl={applicationInitialUrl(initialUrl)}
					principal={principal}
					csrfToken={controls.csrfToken}
					signOut={controls.signOut}
					switchTenant={controls.switchTenant}
				/>}
		/>
	</Head>
}
