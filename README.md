# BitCrack Manager (multi-instance)

Node.js manager for **cuBitCrack** (CUDA) that runs on Linux machines.

- Detects whether the machine has an **NVIDIA GPU**.
  - **GPU available** → runs **one `cuBitCrack` instance per GPU**, each pinned to a device (`-d <n>`).
  - **No GPU** → runs **no instances**; keeps monitoring and reporting to Discord (monitor-only mode).
- Every instance gets its **own workspace** (`instances/instance_<n>/`), its **own `progress.txt`**, and a **distinct non-overlapping slice** of the key range, so instances never scan the same range.
- All instances read the **same** `btc_database.txt`; each writes to its **own** found file, and the manager **merges (dedupes)** everything into the shared `btc_found.txt`, then notifies Discord.
- Restart logic kills by **PID only** (never by binary name), so parallel instances can't kill each other.

## Requirements (Linux target machine)

- **Node.js ≥ 18** (see `scripts/setup-node.sh`)
- The `cuBitCrack` binary (ELF, CUDA build) placed **next to `index.js`**
- `btc_database.txt` (the address list) in the project folder
- NVIDIA driver + CUDA toolkit (for GPU mode)

## Directory layout

```
BitCrackManage/
├── index.js             # entry point / orchestrator
├── config.js            # all settings (edit this)
├── package.json
├── btc_database.txt     # shared input (read by all instances)
├── btc_found.txt        # shared output (merged, deduplicated)
├── cuBitCrack           # GPU binary (must be deployed)
├── lib/                 # modules (gpu, ranges, instance, manager, found, discord, logger)
├── scripts/setup-node.sh# installs Node 20 LTS on Debian/Ubuntu
└── instances/           # created at runtime
    ├── instance_0/
    │   ├── progress.txt # this instance's private progress
    │   └── btc_found_0.txt
    ├── instance_1/
    └── ...
```

## How it works

1. **GPU detection** (`lib/gpu.js`): tries `nvidia-smi -L`, then `/proc/driver/nvidia/gpus`, then `cudaInfo.exe` (Windows dev only).
2. **Mode resolution** (`config.js -> mode`):
   - `auto` (default): GPU if NVIDIA found, otherwise monitor-only.
   - `gpu`: force GPU instances.
   - `none`: force monitor-only.
3. **Range partitioning** (`lib/ranges.js`): the configured key range is split into N contiguous segments. Instance *i* scans `[segment_i.start, segment_i.end]`.
4. **Per-instance workspaces** (`lib/instance.js`): each instance writes its own `progress.txt` (resumes on restart) and its own found file.
5. **Merging + Discord** (`lib/found.js`): polls every instance's found file, appends new unique keys to `btc_found.txt`, and posts them to Discord. Every 10 minutes it also sends the full `btc_found.txt` contents (chunked).

## Configuration (`config.js`)

| Setting | Default | Meaning |
| --- | --- | --- |
| `mode` | `auto` | `auto` / `gpu` / `none` |
| `gpuBinary` | `cuBitCrack` | binary name in the project folder |
| `bitcrack.bits/threads/points` | `32 / 256 / 16` | `-b -t -p` flags |
| `instancesPerGpu` | `1` | processes per GPU device |
| `keyRange.startHex/endHex` | 0x40… → 0x3ff… | range partitioned across instances |
| `restartIntervalMs` | 10 min | force-restart per instance |
| `checkIntervalMs` | 30 s | health-check loop |
| `foundScanIntervalMs` | 5 s | merge scan interval |
| `foundSendIntervalMs` | 10 min | full `btc_found.txt` Discord send |
| `discordWebhook` / `statusWebhook` | — | Discord endpoints |

## Deploy on a Linux machine

```bash
# 1. Install Node 20 LTS (Ubuntu/Debian)
sudo bash scripts/setup-node.sh

# 2. Put this folder on the machine (e.g. scp/rsync), then:
cd BitCrackManage

# 3. Make sure the GPU binary is present & executable
ls -l cuBitCrack
chmod +x cuBitCrack

# 4. Sanity check GPU detection
nvidia-smi -L        # expected if GPU mode

# 5. Start
npm start
```

### Run as a service (systemd)

`/etc/systemd/system/cubitcrack.service`:

```ini
[Unit]
Description=BitCrack multi-instance manager
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/BitCrackManage
ExecStart=/usr/bin/node /opt/BitCrackManage/index.js
Restart=always
RestartSec=10
User=root

[Install]
WantedBy=multi-user.target
```

```bash
sudo cp cubitcrack.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cubitcrack
journalctl -u cubitcrack -f
```

## Notes / caveats

- `cuBitCrack` **requires** an NVIDIA GPU + CUDA. CPU-only machines get monitor-only mode by design (edit `config.js` if you later want CPU workers — a CPU-capable BitCrack build would need to be added).
- On Windows dev boxes the same code runs but falls back to `cudaInfo.exe` for detection; deployment target is Linux.
- Each instance's progress file resumes where it left off, so restarts don't rescan from zero.
