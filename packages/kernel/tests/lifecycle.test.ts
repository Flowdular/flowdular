import { describe, expect, it } from 'vitest';
import type { Principal } from '../src/acl.ts';
import { RegistryError } from '../src/errors.ts';
import { defineLifecycle, lifecycleFromSpec } from '../src/lifecycle.ts';

function principal(...permissions: string[]): Principal {
	return {
		id: 'account-1',
		permissions: new Set(permissions),
	};
}

const read = 'claims.records.read';
const manage = 'claims.records.manage';
const decide = 'claims.records.decide';

/* A declared lifecycle is a promise about which states a record may hold and how
   it moves between them. Before this existed the schema carried the promise and
   the code ignored it, so a status column was writable by any update. */
describe('defineLifecycle', () => {
	const claims = () =>
		defineLifecycle({
			id: 'claims.records',
			field: 'status',
			states: ['draft', 'investigation', 'approved', 'paid', 'closed'],
			transitions: [
				{ from: 'draft', to: 'investigation', permission: manage },
				{ from: 'draft', to: 'closed', permission: decide },
				{ from: 'investigation', to: 'approved', permission: decide },
				{ from: 'investigation', to: 'closed', permission: decide },
				{ from: 'approved', to: 'paid', permission: manage },
				{ from: 'paid', to: 'closed' },
			],
		});

	it('starts in the first declared state unless one is named', () => {
		expect(claims().initial).toBe('draft');
		expect(
			defineLifecycle({
				id: 'x',
				field: 'state',
				states: ['a', 'b'],
				initial: 'b',
				transitions: [],
			}).initial,
		).toBe('b');
	});

	it('allows a declared move when the principal holds the permission', () => {
		expect(
			claims().authorize(principal(read, manage), 'draft', 'investigation'),
		).toEqual({ allowed: true });
	});

	it('refuses a move the specification did not declare', () => {
		const decision = claims().authorize(
			principal(read, manage, decide),
			'draft',
			'paid',
		);
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe('TRANSITION_NOT_ALLOWED');
		/* The refusal names what was allowed, so a screen can offer the moves. */
		expect(decision.message).toContain('investigation');
		expect(decision.message).toContain('closed');
	});

	it('refuses a declared move the principal has no permission for', () => {
		const decision = claims().authorize(
			principal(read),
			'draft',
			'investigation',
		);
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe('PERMISSION_REQUIRED');
		expect(decision.permission).toBe(manage);
	});

	it('allows a move that declares no permission for anyone who may write', () => {
		expect(claims().authorize(principal(read), 'paid', 'closed')).toEqual({
			allowed: true,
		});
	});

	it('treats a save that changes nothing as allowed', () => {
		expect(claims().authorize(principal(read), 'draft', 'draft')).toEqual({
			allowed: true,
		});
	});

	/* The state type already refuses an undeclared state at compile time. The
	   runtime guard still has to refuse one, because a status can arrive as a
	   string from a request, a job or an older row. */
	it('refuses an unknown state on either side', () => {
		const lifecycle = claims();
		const undeclared = 'invent' as Parameters<typeof lifecycle.authorize>[1];
		expect(
			lifecycle.authorize(principal(read, manage, decide), undeclared, 'draft')
				.reason,
		).toBe('STATE_UNKNOWN');
		expect(
			lifecycle.authorize(principal(read, manage, decide), 'draft', undeclared)
				.reason,
		).toBe('STATE_UNKNOWN');
	});

	it('accepts anything that carries a permission set', () => {
		/* A server endpoint identity has subjectId, not id, and the lifecycle
		   needs only the scopes. */
		const identity = {
			subjectId: 'account-1',
			permissions: new Set([manage]),
		};
		expect(
			claims().authorize(
				identity as unknown as { readonly permissions: ReadonlySet<string> },
				'draft',
				'investigation',
			).allowed,
		).toBe(true);
	});

	it('reports the moves out of a state and which states are finished', () => {
		const lifecycle = claims();
		expect(lifecycle.targets('draft')).toEqual(['closed', 'investigation']);
		expect(lifecycle.targets('draft')).not.toContain('draft');
		expect(lifecycle.isTerminal('closed')).toBe(true);
		expect(lifecycle.isTerminal('draft')).toBe(false);
	});

	it('offers the moves with their permissions for a screen to render', () => {
		expect(claims().movesFrom('investigation')).toEqual([
			{ from: 'investigation', to: 'approved', permission: decide },
			{ from: 'investigation', to: 'closed', permission: decide },
		]);
	});

	it('never lists a state that was not declared as a target', () => {
		const lifecycle = claims();
		for (const state of lifecycle.states) {
			for (const target of lifecycle.targets(state)) {
				expect(lifecycle.states).toContain(target);
			}
		}
	});

	/* A malformed declaration has no correct response at write time, so it is a
	   programming error and fails at compose instead. */
	describe('refuses a malformed declaration', () => {
		const base = {
			id: 'x',
			field: 'state',
			states: ['a', 'b'],
			transitions: [{ from: 'a', to: 'b' as const }],
		};

		it('when a move names an undeclared state', () => {
			expect(() =>
				defineLifecycle({
					...base,
					transitions: [{ from: 'a', to: 'nowhere' }],
				}),
			).toThrow(RegistryError);
		});

		it('when the same move is declared twice', () => {
			expect(() =>
				defineLifecycle({
					...base,
					transitions: [
						{ from: 'a', to: 'b' },
						{ from: 'a', to: 'b' },
					],
				}),
			).toThrow(/twice/);
		});

		it('when a state is declared twice', () => {
			expect(() =>
				defineLifecycle({ ...base, states: ['a', 'a', 'b'] }),
			).toThrow(/same state twice/);
		});

		it('when it starts in a state it does not declare', () => {
			expect(() => defineLifecycle({ ...base, initial: 'nowhere' })).toThrow(
				/does not declare/,
			);
		});

		it('when it declares no state', () => {
			expect(() => defineLifecycle({ ...base, states: [] })).toThrow(
				RegistryError,
			);
		});

		it('and treats a move to itself as no move at all', () => {
			const lifecycle = defineLifecycle({
				...base,
				transitions: [
					{ from: 'a', to: 'a' },
					{ from: 'a', to: 'b' },
				],
			});
			expect(lifecycle.targets('a')).toEqual(['b']);
			expect(lifecycle.declares('a', 'a')).toBe(false);
		});
	});

	describe('lifecycleFromSpec', () => {
		it('builds the same guard from a specification states block', () => {
			const lifecycle = lifecycleFromSpec({
				id: 'claims.records',
				field: 'status',
				values: ['draft', 'investigation'],
				transitions: [
					{ from: 'draft', to: 'investigation', permission: manage },
				],
			});
			expect(lifecycle.field).toBe('status');
			expect(
				lifecycle.authorize(principal(manage), 'draft', 'investigation')
					.allowed,
			).toBe(true);
			expect(
				lifecycle.authorize(principal(), 'draft', 'investigation').reason,
			).toBe('PERMISSION_REQUIRED');
		});

		it('leaves a move open when the specification named no permission', () => {
			const lifecycle = lifecycleFromSpec({
				id: 'claims.records',
				field: 'status',
				values: ['open', 'closed'],
				transitions: [{ from: 'open', to: 'closed' }],
			});
			expect(lifecycle.authorize(principal(read), 'open', 'closed')).toEqual({
				allowed: true,
			});
		});
	});
});
