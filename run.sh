#!/bin/bash
#
# run.sh - Setup/start script for the BitCrack manager
#   1. Make cuBitCrack executable (chmod 777)
#   2. Register index.js as a pm2 service (if not already) and enable startup (auto-start on boot)
#

# Run from the script's own directory so relative paths (index.js, cuBitCrack) work
cd "$(dirname "$0")"

SERVICE_NAME="cubitcrack-manager"

echo "[run.sh] Step 1: chmod 777 cuBitCrack"
chmod 777 cuBitCrack

# Make sure pm2 is available
if ! command -v pm2 >/dev/null 2>&1; then
    echo "[run.sh] pm2 not found, installing globally..."
    npm install -g pm2 || { echo "[run.sh] ERROR: failed to install pm2"; exit 1; }
fi

echo "[run.sh] Step 2: checking if '$SERVICE_NAME' is registered with pm2"
if pm2 describe "$SERVICE_NAME" >/dev/null 2>&1; then
    echo "[run.sh] '$SERVICE_NAME' already registered. Restarting to ensure it is running..."
    pm2 restart "$SERVICE_NAME"
else
    echo "[run.sh] '$SERVICE_NAME' not registered. Registering as a pm2 service..."
    pm2 start index.js --name "$SERVICE_NAME"
    pm2 save

    echo "[run.sh] Enabling pm2 startup (auto-start on boot)..."
    # Try non-interactive sudo first so the script doesn't hang on a password prompt
    if ! sudo -n env PATH="$PATH" pm2 startup systemd -u "$USER" --hp "$HOME" >/dev/null 2>&1; then
        pm2 startup systemd -u "$USER" --hp "$HOME" >/dev/null 2>&1 \
            || echo "[run.sh] WARNING: could not auto-configure pm2 startup."
    fi
    echo "[run.sh] You may need to run the following once with sudo to fully enable startup:"
    echo "    sudo env PATH=\$PATH pm2 startup systemd -u $USER --hp $HOME"
    pm2 save
fi

echo "[run.sh] Current pm2 status:"
pm2 status

echo "[run.sh] Done."
