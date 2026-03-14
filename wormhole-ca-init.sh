#!/bin/sh
# Install the wormhole CA into the system trust store, then exec the wrapped command.
# Usage: entrypoint: ["/etc/mwh/wormhole-ca-init.sh", "node", "app.js"]

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
CERT_PATH="${MWH_CA_CERT_PATH:-${MWH_TRUST_DIR:-$SCRIPT_DIR}/ca.crt}"

if [ -f "$CERT_PATH" ]; then
  # System trust store (works for curl, Go, etc.)
  cp "$CERT_PATH" /usr/local/share/ca-certificates/mwh-ca.crt 2>/dev/null
  update-ca-certificates 2>/dev/null || true

  # Runtime-specific env vars (set only if not already defined)
  export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--use-openssl-ca"
  export NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-$CERT_PATH}"
  export SSL_CERT_FILE="${SSL_CERT_FILE:-$CERT_PATH}"
  export REQUESTS_CA_BUNDLE="${REQUESTS_CA_BUNDLE:-$CERT_PATH}"
fi

exec "$@"
