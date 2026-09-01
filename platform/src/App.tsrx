import { ApplicationShell, shellLocationFromUrl } from '@coreloom/client';
import {
	AuthenticationCore,
	authScreenFromUrl,
} from '@coreloom/module-auth/client';
import type { AuthPrincipal } from '@coreloom/module-auth';
import { Head, Seo } from '@octanejs/seo';
import type { RenderRouteProps } from '@octanejs/vite-plugin';
import { createModuleClientContributions } from './generated/modules.client.ts';
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
				})}
				identity={props.principal}
				onSignOut={props.signOut}
				onSwitchTenant={props.switchTenant}
			/>
		} @else {
			<main class="access-denied">
				<span>403</span>
				<h1>Workspace access was not granted.</h1>
				<p>
					Your account is authenticated, but it does not have the
					system.workspace.access scope.
				</p>
				<button
					class="ui-btn ui-btn--primary"
					type="button"
					onClick={() => void props.signOut()}
				>
					Sign out
				</button>
			</main>
		}
	</div>
}

export function App(props?: RenderRouteProps) @{
	const initialUrl =
		props?.url ?? (typeof window === 'undefined' ? '/' : window.location.href);
	<Head>
		<Seo
			title="Workspace"
			titleTemplate="%s · Coreloom"
			description="An agentic foundation framework: a production platform core that teams extend with modules built by AI agents."
			robots={{ index: false, follow: false, noarchive: true }}
			openGraph={{
				type: 'website',
				siteName: 'Coreloom',
				images: [
					{
						url: '/og.png',
						width: 1200,
						height: 630,
						alt: 'Coreloom. Agentic foundation framework.',
					},
				],
			}}
			twitter={{ card: 'summary_large_image', image: '/og.png' }}
		/>
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
