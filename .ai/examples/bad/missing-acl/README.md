# Bad example: endpoint without access control

`endpoints.ts` mounts `/api/customers` with `new ServerRoute` from `@octanejs/app-core`. Nothing resolves an identity, nothing checks a permission, and `listAll()` has no tenant. Anyone who can reach the server reads every tenant's customers.

Violated rules: `AGENTS.md` 5 (every endpoint is `defineEndpoint` with `access: { kind: 'permission' }` and `resolveIdentity: endpointIdentityFromContext`) and 6 (tenant id from the principal). The security skill's first grep (`grep -rn "new ServerRoute" modules/*/src | grep -v modules/auth`) finds it.

Repair with the `bug-fix` blueprint (or `edit-module`, change class `endpoint`):

```ts
const list = defineEndpoint({
	id: 'customers.records.list',
	path: '/api/customers',
	methods: ['GET'],
	access: { kind: 'permission', permission: CUSTOMER_PERMISSIONS.read },
	resolveIdentity: endpointIdentityFromContext,
	handler: ({ octane }) =>
		jsonResponse({
			customers: runtime.service().list(principalFromContext(octane)!.tenantId),
		}),
});
```

Reference: `.ai/references/catalog/src/api/endpoints.ts`.
