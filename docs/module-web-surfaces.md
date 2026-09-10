# Module-owned web surfaces

A module can provide workspace administration, HTTP APIs and independently laid
out web pages in the same installation. Web pages are optional server composition
contributions. They do not render `ApplicationShell` or `AuthenticationCore`.
Access and presentation are independent: a standalone portal may still require
authentication or a permission.

## Module declaration

Use the normal approved module specification and `platform.server: true` entry.
Declare the public interface and its visibility rules in that specification.
No new manifest capability or separate business module is required.

```ts
import { defineWebSurface } from '@flowdular/sdk/server';
import type { ModuleServerComposition } from '@flowdular/sdk/server';

export function createServerComposition(): ModuleServerComposition {
	return {
		routes: [], // Existing protected administration APIs can remain here.
		web: [
			defineWebSurface({
				id: 'public',
				pages: [
					{
						id: 'record',
						path: '/records/:slug',
						entry: ['RecordPage', '@example/module/web'],
						layout: '@example/module/web-layout',
						access: { kind: 'public' },
						async load({ site, params, signal }) {
							// Call your module's service with site.tenantId.
							// Read inside a tenant-scoped, read-only transaction.
							// Return 404 if the record is missing or is not public.
							return { title: 'Public record', slug: params.slug ?? '' };
						},
					},
				],
			}),
		],
	};
}
```

Add browser-safe package exports for the page and optional layout:

```json
{
	"exports": {
		"./platform": "./src/platform.ts",
		"./web": "./src/web/RecordPage.tsrx",
		"./web-layout": "./src/web/Layout.tsrx"
	}
}
```

Use package subpaths, not workspace absolute paths. These entries go through
Octane's normal development and production SSR/hydration compilation. Keep
database, credentials and server imports out of both page and layout. Declare
all imported dependencies in the package manifest. Reuse the shared translation
runtime and the module's existing bundles when localization is needed.

## Operator configuration

Add the optional `web` section in the installation's `flowdular.json`:

```json
{
	"web": {
		"mounts": [
			{
				"id": "acme-public",
				"moduleId": "example.core",
				"surfaceId": "public",
				"path": "/blog",
				"tenantId": "the-existing-acme-tenant-id",
				"enabled": true
			}
		]
	}
}
```

Run `pnpm flowdular module sync --apply`, then rebuild/redeploy production or
restart development. Configuration is generated into the server composition;
changing it requires regeneration. It is not read from a process-local settings
cache or an anonymous query parameter. Verify the tenant ID before publishing.
The same module surface can be mounted for multiple tenants under different
paths. `/records/:slug` above becomes `/blog/records/:slug`.

The root `/` can host a public storefront, alongside more specific mounts such as
`/blog`. Reserved platform prefixes such as `/app`, `/auth`, `/api`, `/setup` and
the configured backoffice path cannot be claimed by modules. Other overlapping
mounts and equivalent route patterns are rejected. Custom paths such as `/blog`, `/portal` and `/forms/contact` work without a
tenant ID in the URL. `/sites/` is an optional convention for multiple sites;
unknown sites under that prefix return 404. A disabled binding
or an uninstalled/disabled module leaves its configured address returning 404.
Keep that disabled binding when retiring an address so it cannot fall through
to legacy workspace routing. Remove the binding only when releasing the address.

### Backoffice address

The first-run setup includes **Backoffice address**, defaulting to `/app` (or the
installation's configured default). Choose `/backoffice` to leave `/` available
for a storefront. Setup validates the address, includes it in the review, and
writes `FD_APPLICATION_PATH=/backoffice` alongside the database settings. Restart
after setup; no client rebuild is needed for this environment setting. On a
read-only deployment setup provides the environment block to paste into the
hosting service. If `FD_APPLICATION_PATH` already exists in the environment, it
is authoritative; setup cannot silently replace it.

For configuration managed in source control, add:

```json
{
	"application": { "path": "/backoffice" },
	"web": {
		"mounts": [
			{
				"id": "store",
				"moduleId": "example.core",
				"surfaceId": "public",
				"path": "/",
				"tenantId": "the-existing-tenant-id"
			}
		]
	}
}
```

Run module sync and rebuild after changing `flowdular.json`. At startup,
`FD_APPLICATION_PATH` overrides `application.path`; `/app` is the fallback.
The value is installation-wide, one lowercase path segment of at most 64
characters. Navigation, authentication redirects and dashboard deep links use
it. When changed from `/app`, old `/app/...` bookmarks redirect permanently to
the configured address, preserving the suffix and query. Authentication pages
remain under `/auth/...`. A root mount removes the legacy slug-first dashboard
aliases; unknown public URLs return 404 instead of displaying the dashboard.

This release supports path mounts. Custom hostname binding, DNS ownership and
TLS provisioning are a separate deployment feature. It does not download or
activate executable modules at request time.

## Page and hydration

```tsx
import { Head, Seo } from '@octanejs/seo';
import { webPageData } from '@flowdular/sdk/client/web';
import type { RenderRouteProps } from '@octanejs/vite-plugin';

export function RecordPage(props: RenderRouteProps) @{
	const record = webPageData<{ title: string; slug: string }>(props);
	<Head>
		<Seo title={record.title} description="A public record" />
		<main><h1>{record.title}</h1><p>{record.slug}</p></main>
	</Head>
}
```

`load` runs before rendering, so it can return an actual 404 or redirect before
streaming starts. Its JSON result is the only data serialized into the page;
the authentication state, database handles and the rest of `Context.state` are
never serialized. `webPageData` reads that exact DTO on the server and during
hydration, with no second fetch. A layout receives the usual Octane page props
and `children`. Pages own their metadata, styling and UI states.

For an explicit refresh or client navigation, use
`loadWebPage<T>(url, abortSignal)` from the same client subpath. It requests the
same URL with `Accept: application/vnd.flowdular.page+json`, which runs the same
tenant, access and loader checks. Native links and deep-link refresh also work.
The page loader and data representation accept only GET/HEAD, never mutations.
Existing module endpoints remain the mechanism for writes; they must retain
their permission, CSRF and input-validation rules.

## Access and safety

- `public`: the loader's identity is always null, even if the visitor has a
  dashboard session for another tenant. Data ownership comes from `site.tenantId`.
- `authenticated`: requires an authenticated principal whose active tenant
  matches the configured site tenant. Otherwise returns 401 or 403.
- `permission`: additionally requires the declared permission, for example
  `{ kind: 'permission', permission: 'example.records.read' }`.

The module must enforce record visibility inside its own service. Tenant RLS
alone does not hide private records from a public visitor to that same tenant.
Never reuse an unrestricted administration query as a public loader. Return
`new Response('Not found', { status: 404 })` for inaccessible content. Use the
request signal to cancel database or external work and bound query inputs.

All responses use `Cache-Control: no-store`; the HTML and JSON representations
vary on `Accept`. Shared/CDN caching is deliberately disabled until an explicit
tenant-aware invalidation policy is configured in a future extension. Page JSON
is bounded to 1 MiB. Unexpected failures return safe errors without raw secrets.
The host lifecycle drains response streams on completion, cancellation, errors
and request abort before releasing module resources.

Installed modules remain trusted code in the host process. Module composition
types now live in the shared server API; auth exports compatibility aliases for
existing modules. This extension is not a runtime security sandbox.

## Validation

Run module typechecks and tests, `pnpm verify`, and `pnpm build`. Cover public
and denied access, two tenants using the same slug, draft/private records,
redirects, 404s, deep links, cancellation and DTO contents. The shared production
integration test is `node scripts/smoke-web.mjs`; it creates an isolated fixture,
runs the real CLI composition generator, compiles the page and layout, and
checks production HTTP behavior. `FD_WEB_SMOKE_KEEP=true` retains its temporary
server for manual hydration and keyboard checks. No operator module is enabled
and no real tenant data is used by that test.
