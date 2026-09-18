import { definePgliteTestConfig } from './src/vitest-preset.ts';

/* The package that owns the preset was the one suite missing it: its own tests
   boot the embedded PostgreSQL and were left on the 5s vitest default, so they
   failed only in a full workspace run. Imported by path rather than by package
   name, which would resolve this package through its own exports. */
export default definePgliteTestConfig();
