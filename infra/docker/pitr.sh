#!/usr/bin/env bash
# Point-in-time recovery for the compose stack. Base backups land in the WAL
# archive volume next to the segments; a restore replaces the cluster with one
# base backup and replays the archive up to a target time. Nothing here runs
# while the app container serves the database unless --stop-app says to stop
# it first.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
compose=(docker compose -f "$here/compose.yaml")
archive=/var/lib/postgresql/wal-archive
recovery_wait_seconds=600

usage() {
	cat <<'USAGE'
Usage:
  pitr.sh base-backup
      Take a base backup of the running postgres service into the WAL archive
      volume (base/<stamp>/base.tar.gz).
  pitr.sh list
      List the base backups the archive volume holds.
  pitr.sh restore --base <stamp> [--target-time '<YYYY-MM-DD HH:MM:SS+00>'] \
      --confirm replace-cluster [--stop-app]
      Delete the current cluster, unpack <stamp> and replay the archive up to
      the target time (to the end of the archive without one). Refuses while
      the app container is running unless --stop-app is passed.
USAGE
}

running() {
	"${compose[@]}" ps --services --status running | grep -qx "$1"
}

base_backup() {
	if ! running postgres; then
		echo "The postgres service is not running; start it before taking a base backup." >&2
		exit 1
	fi
	local stamp
	stamp="$(date -u +%Y%m%dT%H%M%SZ)"
	"${compose[@]}" exec -T -u postgres postgres \
		pg_basebackup -U postgres -D "$archive/base/$stamp" -Ft -z -X fetch -c fast -P
	echo "Base backup $stamp is in the flowdular-postgres-wal volume under base/$stamp."
	echo "Copy it off the host: docker compose -f $here/compose.yaml cp postgres:$archive/base/$stamp <dir>"
}

list() {
	"${compose[@]}" run --rm --no-deps -T --entrypoint bash postgres \
		-c "ls -1 $archive/base 2>/dev/null || true"
}

# Runs inside a one-off postgres container as root, with the data and archive
# volumes mounted. PITR_BASE and PITR_TARGET_TIME come from the environment.
read -r -d '' replace_cluster <<'SCRIPT' || true
set -euo pipefail
archive=/var/lib/postgresql/wal-archive
pgdata=/var/lib/postgresql/data
tarball="$archive/base/$PITR_BASE/base.tar.gz"
if [ ! -f "$tarball" ]; then
	echo "No base backup at $tarball." >&2
	exit 1
fi
find "$pgdata" -mindepth 1 -delete
tar -xzf "$tarball" -C "$pgdata"
{
	echo ""
	echo "# pitr.sh"
	echo "restore_command = 'cp $archive/%f %p'"
	if [ -n "$PITR_TARGET_TIME" ]; then
		echo "recovery_target_time = '${PITR_TARGET_TIME//\'/\'\'}'"
	fi
	echo "recovery_target_action = 'promote'"
} >>"$pgdata/postgresql.conf"
touch "$pgdata/recovery.signal"
chown -R postgres:postgres "$pgdata"
chmod 700 "$pgdata"
SCRIPT

restore() {
	local base="" target_time="" confirm="" stop_app=false
	while [ $# -gt 0 ]; do
		case "$1" in
		--base)
			base="${2:?--base needs a value}"
			shift 2
			;;
		--target-time)
			target_time="${2:?--target-time needs a value}"
			shift 2
			;;
		--confirm)
			confirm="${2:?--confirm needs a value}"
			shift 2
			;;
		--stop-app)
			stop_app=true
			shift
			;;
		*)
			echo "Unknown option: $1" >&2
			usage >&2
			exit 2
			;;
		esac
	done
	if [ -z "$base" ]; then
		echo "--base <stamp> is required; pitr.sh list shows the candidates." >&2
		exit 2
	fi
	case "$base" in
	*/* | .*)
		echo "--base must be a plain backup name." >&2
		exit 2
		;;
	esac
	if [ -n "$target_time" ] &&
		! [[ "$target_time" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}[\ T][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)?$ ]]; then
		echo "--target-time must look like '2026-09-14 09:30:00+00' (date, time, optional fraction and offset)." >&2
		exit 2
	fi
	if [ "$confirm" != replace-cluster ]; then
		echo "The current cluster is deleted before the base backup is unpacked. Pass --confirm replace-cluster." >&2
		exit 2
	fi
	if running app; then
		if [ "$stop_app" = true ]; then
			"${compose[@]}" stop app
		else
			echo "The app container is running and serves the database about to be replaced. Stop it (docker compose stop app) or pass --stop-app." >&2
			exit 1
		fi
	fi
	"${compose[@]}" stop postgres
	"${compose[@]}" run --rm --no-deps -T \
		-e PITR_BASE="$base" -e PITR_TARGET_TIME="$target_time" \
		--entrypoint bash postgres -c "$replace_cluster"
	"${compose[@]}" up -d postgres
	echo "Replaying the archive; waiting up to $recovery_wait_seconds seconds for promotion."
	local waited=0 state
	while [ "$waited" -lt "$recovery_wait_seconds" ]; do
		state="$("${compose[@]}" exec -T -u postgres postgres \
			psql -U postgres -d postgres -tAc 'select pg_is_in_recovery()' 2>/dev/null || true)"
		if [ "$state" = f ]; then
			echo "Recovery finished and the server promoted."
			echo "Check the log for the recovery stop point: docker compose -f $here/compose.yaml logs postgres | grep -i 'recovery stopping'"
			echo "Then start the app (docker compose -f $here/compose.yaml up -d app), run pnpm flowdular migration verify and check GET /api/ready."
			return 0
		fi
		sleep 5
		waited=$((waited + 5))
	done
	echo "The server is still in recovery after $recovery_wait_seconds seconds. Read docker compose -f $here/compose.yaml logs postgres before doing anything else." >&2
	exit 1
}

case "${1:-}" in
base-backup)
	shift
	base_backup "$@"
	;;
list)
	shift
	list "$@"
	;;
restore)
	shift
	restore "$@"
	;;
-h | --help | help | "")
	usage
	;;
*)
	echo "Unknown command: $1" >&2
	usage >&2
	exit 2
	;;
esac
