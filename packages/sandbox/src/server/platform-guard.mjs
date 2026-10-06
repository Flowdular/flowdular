import { spawn } from 'node:child_process';

/* platform-process.ts starts the platform through this guard, and
   process-command.ts every bounded command. The guard leads the command's
   process group and holds an IPC channel to the launcher. The
   launcher stops the group on every path it runs; the channel covers the ones
   it never reaches (SIGKILL, SIGHUP from a closed terminal, a crash, a test
   runner torn down). The operating system closes the channel however the
   launcher ends, and the guard then stops the group it leads.

   The channel is this process's stdin. The child gets its own stdin, because
   Linux would otherwise pass the channel's descriptor down to every platform
   process and keep it open after the guard exits.

   The caller passes the delay from SIGTERM to SIGKILL first. */
const [grace, command, ...args] = process.argv.slice(2);
const STOP_GRACE_MS = Number(grace);
const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'] });
let stopping = false;

function signalGroup(signal) {
	try {
		process.kill(-process.pid, signal);
	} catch {
		/* No group of its own to signal. */
	}
}

/* Once a stop has begun the guard outlives the SIGTERM and owns the SIGKILL,
   so the group is stopped even if the launcher dies before it is. */
function stop() {
	if (stopping) return;
	stopping = true;
	setTimeout(() => signalGroup('SIGKILL'), STOP_GRACE_MS);
}

function launcherGone() {
	if (process.platform === 'win32') {
		/* No process groups: end the child's whole tree. */
		if (child.pid !== undefined)
			spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
				stdio: 'ignore',
				windowsHide: true,
			}).once('error', () => undefined);
		return;
	}
	if (stopping) return;
	stop();
	signalGroup('SIGTERM');
}

child.once('error', (error) => {
	const exit = () => process.exit(1);
	if (!process.connected) return exit();
	process.send({ type: 'spawn-error', message: error.message }, exit);
});
child.once('exit', (code) => {
	/* pnpm exits after its script, so whatever is left of a stopping group
	   has outlived the platform. */
	if (stopping) signalGroup('SIGKILL');
	process.exit(code ?? 1);
});

/* stop() in the launcher signals the whole group, this guard included. */
process.on('SIGTERM', stop);
process.once('disconnect', launcherGone);
/* The channel can close while this module is still loading. */
if (process.send && !process.connected) launcherGone();
