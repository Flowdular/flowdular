import { configureApplicationFromPage } from '@flowdular/sdk/client/routing';
import {
	ApplicationShell,
	activeLocale,
	applicationBranding,
	brandingTitleSuffix,
	configureBrandingFromPage,
	DEFAULT_APPLICATION_BRANDING,
	shellLocationFromUrl,
	t,
} from '@flowdular/sdk/client';
import {
	AuthenticationCore,
	authScreenFromUrl,
} from '@flowdular/sdk/modules/auth/client';
import type { AuthPrincipal } from '@flowdular/sdk/modules/auth';
import { Head, Link, Meta, Seo } from '@octanejs/seo';
import type { RenderRouteProps } from '@octanejs/vite-plugin';
import {
	createModuleClientContributions,
	applicationBasePath,
} from './generated/modules.client.ts';
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
	configureApplicationFromPage(props, applicationBasePath);
	configureBrandingFromPage(props);
	const branding = applicationBranding();
	const initialUrl =
		props?.url ?? (typeof window === 'undefined' ? '/' : window.location.href);
	<Head>
		<Seo
			title={t('shell.workspace.title')}
			titleTemplate={'%s · ' + brandingTitleSuffix(branding)}
			description={branding.description || t('shell.seo.description')}
			robots={{ index: false, follow: false, noarchive: true }}
			openGraph={{ type: 'website', siteName: branding.appName }}
		/>
		<Link rel="icon" href={branding.faviconUrl} />
		<Meta name="theme-color" content={branding.themeColor} />
		{/* A new application ships no preview image of its own, so the link
    preview is declared only once an operator points the setting at one. */}
		@if (branding.ogImageUrl !== DEFAULT_APPLICATION_BRANDING.ogImageUrl) {
			<>
				<Meta property="og:image" content={branding.ogImageUrl} />
				<Meta name="twitter:card" content="summary_large_image" />
				<Meta name="twitter:image" content={branding.ogImageUrl} />
			</>
		}
		<AuthenticationCore
			initialScreen={authScreenFromUrl(initialUrl)}
			renderAuthenticated={(principal, controls) =>
				<AuthenticatedApp
					initialUrl={initialUrl}
					principal={principal}
					csrfToken={controls.csrfToken}
					signOut={controls.signOut}
					switchTenant={controls.switchTenant}
				/>}
		/>
	</Head>
}
