import { configureApplicationFromPage } from '@flowdular/client/routing';
import {
	ApplicationShell,
	activeLocale,
	applicationBranding,
	brandingTitleSuffix,
	configureBrandingFromPage,
	DEFAULT_APPLICATION_BRANDING,
	shellLocationFromUrl,
	t,
} from '@flowdular/client';
import {
	AuthenticationCore,
	authScreenFromUrl,
} from '@flowdular/module-auth/client';
import type { AuthPrincipal } from '@flowdular/module-auth';
import { Head, Link, Meta, Seo } from '@octanejs/seo';
import type { RenderRouteProps } from '@octanejs/vite-plugin';
import {
	createModuleClientContributions,
	applicationBasePath,
} from './generated/modules.client.ts';
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
	configureApplicationFromPage(props, applicationBasePath);
	configureBrandingFromPage(props);
	const branding = applicationBranding();
	/* The dimensions describe the product's own image; an operator's own
   preview is any size, and a wrong hint is worse than none. */
	const ogImage =
		branding.ogImageUrl === DEFAULT_APPLICATION_BRANDING.ogImageUrl
			? {
					url: branding.ogImageUrl,
					width: 1730,
					height: 909,
					alt: t('shell.seo.imageAlt'),
				}
			: { url: branding.ogImageUrl, alt: branding.appName };
	const initialUrl =
		props?.url ?? (typeof window === 'undefined' ? '/' : window.location.href);
	<Head>
		<Seo
			title={t('shell.workspace.title')}
			titleTemplate={'%s · ' + brandingTitleSuffix(branding)}
			description={branding.description || t('shell.seo.description')}
			robots={{ index: false, follow: false, noarchive: true }}
			openGraph={{
				type: 'website',
				siteName: branding.appName,
				images: [ogImage],
			}}
			twitter={{ card: 'summary_large_image', image: branding.ogImageUrl }}
		/>
		<Link rel="icon" href={branding.faviconUrl} />
		<Meta name="theme-color" content={branding.themeColor} />
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
