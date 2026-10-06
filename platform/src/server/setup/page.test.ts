import { validateWorkspaceSlug } from '@flowdular/module-auth/server';
import { describe, expect, it } from 'vitest';
import { WORKSPACE_SLUG_TYPING_FILTER } from './page.ts';

const filter = new Function(`return (${WORKSPACE_SLUG_TYPING_FILTER});`)() as (
	value: string,
) => string;

const TYPED: readonly (readonly [string, string])[] = [
	['Acme', 'acme'],
	['ACME-CORP', 'acme-corp'],
	['acme corp', 'acme-corp'],
	['acme \t corp', 'acme-corp'],
	['acme_corp', 'acmecorp'],
	['Zażółć', 'za'],
	['Zażółć gęślą jaźń', 'za-gl-ja'],
	['acme🚀corp', 'acmecorp'],
	['<b>acme</b>', 'bacmeb'],
	['acme--corp', 'acme-corp'],
	['a---b', 'a-b'],
	['-acme', 'acme'],
	['--acme', 'acme'],
	[' acme', 'acme'],
	['acme-', 'acme-'],
	['ab', 'ab'],
	['x'.repeat(60), 'x'.repeat(48)],
	['!'.repeat(10) + 'x'.repeat(50), 'x'.repeat(48)],
	['Acme Corp_2026!', 'acme-corp2026'],
	['acme-finance-2026', 'acme-finance-2026'],
	['', ''],
	['!!!', ''],
];

describe('workspace address typing filter', () => {
	it.each(TYPED)('keeps %j as %j', (typed, kept) => {
		expect(filter(typed)).toBe(kept);
	});

	it('keeps only what auth.core accepts once the address is complete', () => {
		for (const [typed] of TYPED) {
			const kept = filter(typed);
			expect(filter(kept), typed).toBe(kept);
			if (kept.length >= 3 && !kept.endsWith('-')) {
				expect(validateWorkspaceSlug(kept), typed).toBe(kept);
			}
		}
	});

	/* The page keeps of an edit what filtering the text up to the edit adds to
	   the filtered text before it, which needs a filtered prefix to stay a
	   prefix of the filtered whole. */
	it('filters any prefix of a value to a prefix of the filtered value', () => {
		for (const [typed] of TYPED) {
			const whole = filter(typed);
			for (let end = 0; end <= typed.length; end++) {
				expect(whole.startsWith(filter(typed.slice(0, end))), typed).toBe(true);
			}
		}
	});
});
