#!/bin/bash
# Generates the server certificate Postgres presents and the app verifies.
# Idempotent: an existing pair is kept so a restart does not invalidate a
# certificate the app already trusts.
set -euo pipefail

certificate=/tls/server.crt
key=/tls/server.key

# The WAL archive volume is created by Docker as root; archive_command runs as
# postgres (uid 999) and must be able to write into it from the first segment.
install -d -o 999 -g 999 -m 700 /var/lib/postgresql/wal-archive

if [ -s "$certificate" ] && [ -s "$key" ]; then
	echo "PostgreSQL TLS material is already present."
	exit 0
fi

# The common name and SAN must be the compose service name, because the app
# connects to host "postgres" under FD_DATABASE_TLS=verify-full.
openssl req -new -x509 -nodes -days 3650 \
	-newkey rsa:2048 \
	-subj '/CN=postgres' \
	-addext 'subjectAltName=DNS:postgres' \
	-keyout "$key" \
	-out "$certificate"

# Postgres refuses to start when the private key is group or world readable.
chown 999:999 "$key" "$certificate"
chmod 600 "$key"
chmod 644 "$certificate"
echo "Generated a self-signed PostgreSQL server certificate for CN=postgres."
