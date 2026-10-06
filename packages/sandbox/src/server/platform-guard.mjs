import { spawn } from 'node:child_process';

/* platform-process.ts starts the platform through this guard. The guard leads
   the platform's process group and holds an IPC channel to the launcher. The
   launcher stops the group on every path it runs; the channel covers the ones
   it never reaches (SIGKILL, SIGHUP from a closed terminal, a crash, a test
   runner torn down). The operating system closes the channel however the
   launcher ends, and the guard then stops the group it leads. */
const STOP_GRACE_MS = 3_000;

const [command, ...args] = process.argv.slice(2);
const child = spawn(command, args, { stdio: 'inherit' });
let stopping = false;

child.once('error', (error) => {
	const exit = () => process.exit(1);
	if (!process.connected) return exit();
	process.send({ type: 'spawn-error', message: error.message }, exit);
});
child.once('exit', (code) => {
	if (!stopping) process.exit(code ?? 1);
});

process.once('disconnect', () => {
	if (process.platform === 'win32') {
		/* No process groups: stop the direct child and exit with it. */
		child.kill();
		return;
	}
	stopping = true;
	/* The guard is a member of the group it signals and stays to escalate. */
	process.on('SIGTERM', () => undefined);
	process.kill(0, 'SIGTERM');
	setTimeout(() => process.kill(0, 'SIGKILL'), STOP_GRACE_MS);
});
