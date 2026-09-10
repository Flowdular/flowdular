import { run } from './index.ts';

process.exitCode = await run(process.argv.slice(2));
