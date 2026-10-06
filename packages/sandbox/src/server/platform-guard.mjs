import { execFile, spawn } from 'node:child_process';

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
let stopping = false;

function signalGroup(signal) {
	try {
		process.kill(-process.pid, signal);
	} catch {
		/* No group of its own to signal. */
	}
}

/* Whether a process besides this guard (and the ps it runs) is left in the
   group it leads. Without a listing it assumes so, and the SIGKILL timer
   ends the group. */
function othersInGroup() {
	return new Promise((resolve) => {
		const lister = execFile(
			'ps',
			['-A', '-o', 'pid=,pgid='],
			(error, stdout) => {
				if (error) return resolve(true);
				resolve(
					stdout.split('\n').some((line) => {
						const [pid, group] = line.trim().split(/\s+/).map(Number);
						return (
							group === process.pid && pid !== process.pid && pid !== lister.pid
						);
					}),
				);
			},
		);
	});
}

/* Once a stop has begun the guard outlives the SIGTERM and owns the SIGKILL,
   so the group is stopped even if the launcher dies before it is. */
function stop() {
	if (stopping) return;
	stopping = true;
	setTimeout(() => signalGroup('SIGKILL'), STOP_GRACE_MS);
}

/* stop() in the launcher signals the whole group, this guard included. A
   SIGTERM ends the guard until this handler exists, so the handler comes
   before the child: no child runs without a guard to send its SIGKILL. */
process.on('SIGTERM', stop);
const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'] });

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
	const exit = () => process.exit(code ?? 1);
	if (!stopping) return exit();
	/* pnpm can exit while the platform still drains: when sh does not exec
	   the script, the shell between them dies on the group's SIGTERM and pnpm
	   follows it. The guard waits for the rest of its group; the SIGKILL timer
	   that stop() armed ends whatever outlasts the grace. */
	const awaitGroup = () =>
		void othersInGroup().then((left) =>
			left ? setTimeout(awaitGroup, 100) : exit(),
		);
	awaitGroup();
});

process.once('disconnect', launcherGone);
/* The channel can close while this module is still loading. */
if (process.send && !process.connected) launcherGone();
