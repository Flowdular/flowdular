# Bad example: client file importing a server module

`api.ts` sits under `src/client` and imports `../services/database-repository.ts`, which pulls in `@flowdular/database` and its `node:fs`, `node:path` and `node:async_hooks` imports. The Vite client build fails on the Node built-ins, and even where it compiled the browser would hold a database handle and a `tenantId` parameter chosen by the caller, bypassing every endpoint check.

Violated rules: `AGENTS.md` 5 and 6 (data reaches the client only through an endpoint that resolves identity and takes the tenant from the principal) and the layering in `.ai/skills/core-extend/SKILL.md` (client code imports `@flowdular/client`, `@flowdular/ui`, `octane`, `segment-state`, and the module's own `src/client` and `src/domain` types; never `src/services` or `src/server`).

Repair with the `bug-fix` blueprint: replace the import with a `fetch` in `src/client/api.ts` as in `.ai/references/catalog/src/client/api.ts`:

```ts
export async function loadCustomers(): Promise<readonly Customer[]> {
	const response = await fetch('/api/customers', {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	return (await payload<{ readonly customers: readonly Customer[] }>(response))
		.customers;
}
```

The server endpoint supplies the tenant from the principal; the client never names one.
