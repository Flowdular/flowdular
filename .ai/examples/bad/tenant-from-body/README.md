# Bad example: tenant id from the request body

`endpoints.ts` has a permission and an identity resolver, and still lets a member of tenant A create a customer in tenant B by posting `{ "tenantId": "B", "name": "..." }`. The permission check passes because the principal holds `customers.records.manage` in its own tenant; the body decides where the row lands. The mutation also skips `sessionMutationDenial`, so a cross-site form post with a valid cookie would be accepted.

Violated rules: `AGENTS.md` 6 (tenant id only from `principalFromContext(octane)!.tenantId`) and 7 (`sessionMutationDenial(octane, auth)` first on every mutation). The security skill's grep `grep -rn tenantId modules/*/src/api | grep -v principalFromContext` finds it.

Repair with the `bug-fix` blueprint: remove the body field, take `auth: AuthRuntime` in `createCustomerRoutes`, and write

```ts
handler: async ({ octane }) => {
	const denial = sessionMutationDenial(octane, auth);
	if (denial) return denial;
	const value = await readJsonObject(octane.request);
	const tenantId = principalFromContext(octane)!.tenantId;
	...
}
```

Add the test from `.ai/skills/test-hardening/SKILL.md`: a principal of tenant A posting `tenantId: 'B'` still creates in A (the field is ignored or rejected with 400).
