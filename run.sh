#!/bin/bash
#
# run.sh - Setup/start script for the BitCrack manager
#   1. Make cuBitCrack executable (chmod 777)
#   2. Register index.js as a pm2 service (if not already) and enable startup (auto-start on boot)
#

# Run from the script's own directory so relative paths (index.js, cuBitCrack) work

npm install -g pm2

git clone https://github.com/TopSoftdeveloper/BitCrackManage.git

cd /workspace/BitCrackManage

#git checkout 5060

chmod 755 ./cuBitCrack

pm2 delete myapp >/dev/null 2>&1 || true
pm2 start npm --name myapp -- run start
