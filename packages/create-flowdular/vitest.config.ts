import { defineConfig } from 'vitest/config';

/* template/ is the app this package copies out, not part of its own suite: its
   tests run inside a scaffolded workspace, against packages installed there. */
export default defineConfig({
	test: {
		include: ['tests/**/*.test.ts'],
	},
});
