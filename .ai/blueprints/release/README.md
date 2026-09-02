# release

Move a finished change into the platform: a sandbox eject, a pull request from a working tree, or a version tag that builds the container (`.github/workflows/container.yml` on `v*.*.*`). Procedure and conventions: `.ai/skills/release-eject-pr/SKILL.md`.

The release writes nothing by hand. `pnpm coreloom module enable` (which also grants the module's scopes), `pnpm coreloom module sync`, `pnpm install` and `pnpm coreloom auth sync-scopes` produce every non-module file in the commit, and the pull request body names the command for each. An eject stops at the first failed step and removes the files a session deleted. Gates are the repository gates CI runs: `pnpm verify`, `pnpm build`, `pnpm audit --prod --audit-level high`.
