# Development console

Startup output shared by the Flowdular launchers: the brand ready block, the
quiet-by-default Vite logger, the `[octane:*]` event prefixes, and the reload
watcher. The platform and the sandbox print the same way, so one terminal habit
covers both.

`@flowdular/dev-console/shutdown` is how the development server stops: its
shutdown budget, the SIGKILL escalation a supervisor uses (kept above that
budget), and the stop signal handling the server and the application template
share.
