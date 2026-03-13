#!/bin/sh
# Install the wormhole CA into the system trust store, then exec the wrapped command.
# Usage: entrypoint: ["/etc/mwh/wormhole-ca-init.sh", "node", "app.js"]

if [ -f /etc/mwh/ca.crt ]; then
  # System trust store (works for curl, Go, etc.)
  cp /etc/mwh/ca.crt /usr/local/share/ca-certificates/mwh-ca.crt 2>/dev/null
  update-ca-certificates 2>/dev/null || true

  # Runtime-specific env vars (set only if not already defined)
  export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--use-openssl-ca"
  export NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-/etc/mwh/ca.crt}"
  export SSL_CERT_FILE="${SSL_CERT_FILE:-/etc/mwh/ca.crt}"
  export REQUESTS_CA_BUNDLE="${REQUESTS_CA_BUNDLE:-/etc/mwh/ca.crt}"
fi

exec "$@"
