#!/usr/bin/env bash
# Install Node.js 20 LTS on Debian/Ubuntu (via NodeSource).
# Run as root:  sudo bash scripts/setup-node.sh
set -euo pipefail

NODE_MAJOR="${NODE_MAJOR:-20}"

if command -v node >/dev/null 2>&1; then
  CURRENT="$(node -v)"
  echo "Node.js already installed: $CURRENT"
  if [ "$(node -p "process.versions.node.split('.')[0]")" -ge 18 ]; then
    echo "Node >= 18 detected - nothing to do."
    exit 0
  fi
  echo "Installed Node is too old, upgrading..."
fi

# Install the NodeSource setup script for the requested major version.
curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -

apt-get install -y nodejs

echo "-----------------------------------------------------"
echo "Installed:"
node --version
npm --version
echo "-----------------------------------------------------"
