#!/bin/bash
set -euo pipefail

export MWH_CA_DIR="${MWH_CA_DIR:-/var/lib/mwh-ca}"
export MWH_TRUST_DIR="${MWH_TRUST_DIR:-/etc/mwh}"

echo "[entrypoint] Starting wormhole setup..."

# Create proxy user (UID 1337) for loop prevention
if ! id -u mwhproxy >/dev/null 2>&1; then
  adduser -S -H -u 1337 mwhproxy 2>/dev/null || useradd --system --no-create-home --uid 1337 mwhproxy
fi

# Ensure private signer state and app-visible trust directories exist
mkdir -p "$MWH_CA_DIR" "$MWH_TRUST_DIR"
chown mwhproxy "$MWH_CA_DIR"

# Generate CA as mwhproxy user
echo "[entrypoint] Generating CA certificate..."
su -s /bin/sh mwhproxy -c "node --import tsx src/generate-ca.ts" || {
  echo "[entrypoint] FATAL: CA generation failed" >&2
  exit 1
}

# Publish only the public CA cert + init script for app containers
cp "$MWH_CA_DIR/ca.crt" "$MWH_TRUST_DIR/ca.crt"
chmod 0644 "$MWH_TRUST_DIR/ca.crt"
cp /app/wormhole-ca-init.sh "$MWH_TRUST_DIR/wormhole-ca-init.sh"
chmod +x "$MWH_TRUST_DIR/wormhole-ca-init.sh"

# iptables: bypass DNS over TCP, then redirect other outbound TCP to the multiplexer
echo "[entrypoint] Setting up iptables redirect..."
iptables -t nat -A OUTPUT -p tcp --dport 53 -j RETURN || {
  echo "[entrypoint] FATAL: iptables TCP DNS bypass failed" >&2
  exit 1
}
iptables -t nat -A OUTPUT -p tcp -m owner ! --uid-owner 1337 -j REDIRECT --to-ports "${MWH_PORT:-3129}" || {
  echo "[entrypoint] FATAL: iptables redirect failed" >&2
  exit 1
}

# Sandbox: block all other outbound from non-proxy processes
echo "[entrypoint] Setting up sandbox firewall rules..."
iptables -A OUTPUT -m owner --uid-owner 1337 -j ACCEPT || true      # proxy's own upstream requests
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT || true              # DNS resolution
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT || true              # DNS over TCP
iptables -A OUTPUT -d 127.0.0.0/8 -j ACCEPT || true                # loopback (redirected traffic)
iptables -A OUTPUT -j DROP || true                                   # block everything else

echo "[entrypoint] Starting proxy as mwhproxy (UID 1337)..."
exec su -s /bin/sh mwhproxy -c "exec node --import tsx src/index.ts"
