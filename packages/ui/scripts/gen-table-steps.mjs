// Regenerates src/styles/table-steps.css from the steps in table-layout.ts.
// Run: node packages/ui/scripts/gen-table-steps.mjs
import { writeFileSync } from 'node:fs';
import { tableStepsCss } from '../src/components/table-steps.ts';

writeFileSync(
	new URL('../src/styles/table-steps.css', import.meta.url),
	tableStepsCss(),
);
