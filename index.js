const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');
const crypto = require('crypto');

// Configuration
const EXE_NAME = 'cuBitCrack'; // CUDA BitCrack binary (Linux)
const COMMAND_ARGS = ['-b', '32', '-t', '256', '-p', '16', '-i', 'btc_database.txt', '-o', 'btc_found.txt'];
const RESTART_INTERVAL = 1 * 10 * 60 * 1000; // 10min in milliseconds
const CHECK_INTERVAL = 30000; // Check every 30 seconds if process is running
const BTC_FOUND_SEND_INTERVAL = 10 * 60 * 1000; // Send btc_found.txt contents to Discord every 10 minutes

// ============================================================================
// SEARCH RANGE CONFIGURATION  (puzzles 71-74)
// ----------------------------------------------------------------------------
// btc_database.txt holds the addresses for puzzles 71,72,73,74. Each private
// key is hidden uniformly at random inside its own bit range:
//   puzzle 71: [2^70, 2^71)   7.1 BTC
//   puzzle 72: [2^71, 2^72)   7.2 BTC
//   puzzle 73: [2^72, 2^73)   7.3 BTC
//   puzzle 74: [2^73, 2^74)   7.4 BTC
//
// SEARCH_MODE:
//   'full'  - scan the whole combined range [2^70, 2^74).
//             Statistically correct for uniformly-random keys (RECOMMENDED).
//   'focus' - restrict each restart to a narrow "predicted" band (a GAMBLE).
//             WARNING: analysis of ALL solved keys (run `node analyze.js`)
//             shows the ratio between consecutive puzzle keys is NOT stable
//             (it varies ~19x..49x for the 7.0/7.5/8.0/8.5 series) and each
//             key's position inside its range is uniform. The bands below are
//             pure speculation based on the k70->k75 ratio. If the real key
//             sits outside the band you will NEVER find it. Use at your own
//             risk.
// FOCUS_PUZZLE (only used when SEARCH_MODE='focus'):
//   71|72|73|74 - always search that puzzle's focus band
//   0           - rotate through the 71,72,73,74 focus bands each restart
// ============================================================================
const SEARCH_MODE = 'focus'; // 'full' | 'focus'
const FOCUS_PUZZLE = 0;      // 71 | 72 | 73 | 74 | 0 (rotate)

// Full per-puzzle ranges
const PUZZLE_RANGES = {
	71: { start: 0x400000000000000000n, end: 0x7fffffffffffffffffn },
	72: { start: 0x800000000000000000n, end: 0xffffffffffffffffffn },
	73: { start: 0x1000000000000000000n, end: 0x1ffffffffffffffffffn },
	74: { start: 0x2000000000000000000n, end: 0x3ffffffffffffffffffn }
};

// Focus bands = k70->k75 interpolation point +/- 25% of the puzzle's range.
// EXPERIMENTAL gamble bands - see the warning above.
const FOCUS_BANDS = {
	71: { start: 0x52ae7d566cf4200000n, end: 0x72ae7d566cf4200000n },
	72: { start: 0x991d14e3bcd35a0000n, end: 0xd91d14e3bcd35a0000n },
	73: { start: 0x11b3d07c84b5dcc0000n, end: 0x19b3d07c84b5dcc0000n },
	74: { start: 0x20b5dcc63f141200000n, end: 0x30b5dcc63f141200000n }
};

// Combined full range (covers all four puzzles)
const FULL_START = 0x400000000000000000n; // 2^70
const FULL_END = 0x3ffffffffffffffffffn;  // 2^74 - 1

// Pick the range to scan for THIS restart. In 'focus' mode with FOCUS_PUZZLE=0
// the bands rotate so all four predictions get coverage over time.
function selectActiveRange() {
	if (SEARCH_MODE !== 'focus') {
		return { start: FULL_START, end: FULL_END, label: 'full [2^70, 2^74)' };
	}
	const candidates = (FOCUS_PUZZLE >= 71 && FOCUS_PUZZLE <= 74) ? [FOCUS_PUZZLE] : [71, 72, 73, 74];
	const rot = typeof selectActiveRange._rot === 'number' ? selectActiveRange._rot : 0;
	selectActiveRange._rot = rot + 1;
	const p = candidates[rot % candidates.length];
	const b = FOCUS_BANDS[p];
	return {
		start: b.start,
		end: b.end,
		label: `focus#${p} [0x${b.start.toString(16)}, 0x${b.end.toString(16)}]`
	};
}
const DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1539934841280135211/4c6PIuGvvr-D-HrkhfMTZa2Uxaw2urju7WkVuSwY0t5m7Nm6RabZCPfJSvhjvoUhO5c2';
const STATUS_WEBHOOK_URL = 'https://discord.com/api/webhooks/1458502651737018533/yU-GkGxttQ8L5wo6VejE9-Gmg48lLo1J4Cs0Y0Osl8u_tPl-LgcX0bouwwMgQmhXCZSc';

let currentProcess = null;
let restartTimer = null;
let checkInterval = null;
let startTime = null;

// Format BigInt as 64-char uppercase hex (zero-padded)
function formatHex64(value) {
	const hex = value.toString(16).toUpperCase();
	return hex.padStart(64, '0');
}

// Generate random BigInt inside the given range [start, end]
function generateRandomNext(start, end) {
	const size = end - start + 1n;
	const randomBytes = crypto.randomBytes(32);
	let offset = BigInt('0x' + randomBytes.toString('hex'));
	offset = offset % size;
	return start + offset;
}

// Write progress.txt with start/end set to the active range and a random 'next' inside it
// Returns the generated 'next' value
function writeProgressFile(progressPath) {
	const range = selectActiveRange();
	console.log(`[${new Date().toISOString()}] Active search range: ${range.label}`);
	const startHex = formatHex64(range.start);
	const endHex = formatHex64(range.end);
	const nextHex = formatHex64(generateRandomNext(range.start, range.end));
	const strideHex = formatHex64(BigInt(1));

	const lines = [
		`start=${startHex}`,
		`next=${nextHex}`,
		`end=${endHex}`,
		`blocks=32`,
		`threads=256`,
		`points=16`,
		`compression=compressed`,
		`device=0`,
		`elapsed=0`,
		`stride=${strideHex}`
	];

	fs.writeFileSync(progressPath, lines.join('\n'), 'utf8');
	return nextHex;
}

// ---- Discord webhook + btc_found.txt monitor ----
function postDiscord(urlString, message, callback) {
	try {
		const data = JSON.stringify({ content: message });
		const url = new URL(urlString);

		const options = {
			method: 'POST',
			hostname: url.hostname,
			path: url.pathname + url.search,
			headers: {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(data)
			}
		};

		const req = https.request(options, (res) => {
			res.on('data', () => {});
			res.on('end', () => {
				if (typeof callback === 'function') callback();
			});
		});

		req.on('error', (err) => {
			console.error(`[${new Date().toISOString()}] Discord webhook error:`, err.message);
			if (typeof callback === 'function') callback(err);
		});

		req.write(data);
		req.end();
	} catch (err) {
		console.error(`[${new Date().toISOString()}] Discord webhook exception:`, err);
		if (typeof callback === 'function') callback(err);
	}
}

function sendDiscordMessage(message, callback) {
	postDiscord(DISCORD_WEBHOOK_URL, message, callback);
}

function sendStatusDiscordMessage(message, callback) {
	postDiscord(STATUS_WEBHOOK_URL, message, callback);
}

function formatBytesToGiB(bytes) {
	const gib = bytes / (1024 * 1024 * 1024);
	return `${gib.toFixed(2)} GiB`;
}

function getPrimaryMacAddress() {
	const ifaces = os.networkInterfaces();
	for (const name of Object.keys(ifaces)) {
		const entries = ifaces[name] || [];
		for (const entry of entries) {
			if (!entry.internal && entry.mac && entry.mac !== '00:00:00:00:00:00') {
				return entry.mac;
			}
		}
	}
	return 'unknown';
}

function buildStatusMessage(nextValue) {
	const hostname = os.hostname();
	const cpus = os.cpus() || [];
	const cpuModel = cpus.length > 0 ? cpus[0].model : 'unknown';
	const cpuCores = cpus.length;
	const cpuSpeed = cpus.length > 0 && cpus[0].speed ? `${cpus[0].speed} MHz` : 'unknown';
	const totalMem = formatBytesToGiB(os.totalmem());
	const freeMem = formatBytesToGiB(os.freemem());
	const mac = getPrimaryMacAddress();
	const now = new Date().toISOString();

	const lines = [
		'cuBitCrack status: running',
		`Time: ${now}`,
		`Host: ${hostname}`,
		`CPU: ${cpuModel} (${cpuCores} cores @ ${cpuSpeed})`,
		`RAM: ${freeMem} free / ${totalMem} total`,
		`MAC: ${mac}`
	];

	if (nextValue) {
		lines.push(`Next: ${nextValue}`);
	}

	return lines.join('\n');
}

function startBtcFoundMonitor() {
	const filePath = path.join(__dirname, 'btc_found.txt');
	let lastSize = 0;
	let isReading = false;

	function readNewContent(from, to) {
		if (isReading) return;
		isReading = true;
		try {
			const stream = fs.createReadStream(filePath, { start: from, end: to - 1, encoding: 'utf8' });
			let buffer = '';
			stream.on('data', (chunk) => {
				buffer += chunk;
			});
			stream.on('end', () => {
				isReading = false;
				const trimmed = (buffer || '').trim();
				if (trimmed.length > 0) {
					const preview = trimmed.length > 1800 ? trimmed.slice(0, 1800) + '\n...[truncated]...' : trimmed;
					console.log(`[${new Date().toISOString()}] btc_found.txt updated, sending to Discord (${trimmed.length} chars)`);
					sendDiscordMessage('You became Millionaire content:\n```\n' + preview + '\n```');
				}
			});
			stream.on('error', (err) => {
				isReading = false;
				console.error(`[${new Date().toISOString()}] Error reading btc_found.txt:`, err.message);
			});
		} catch (err) {
			isReading = false;
			console.error(`[${new Date().toISOString()}] Exception reading btc_found.txt:`, err.message);
		}
	}

	function primeAndWatch() {
		fs.stat(filePath, (err, stats) => {
			if (!err && stats && stats.isFile()) {
				if (stats.size > 0 && lastSize === 0) {
					readNewContent(0, stats.size);
				}
				lastSize = stats.size;
			}

			try {
				const watcher = fs.watch(filePath, (event) => {
					if (event === 'change') {
						fs.stat(filePath, (err2, stats2) => {
							if (err2 || !stats2) return;
							if (stats2.size > lastSize) {
								const from = lastSize;
								const to = stats2.size;
								lastSize = stats2.size;
								readNewContent(from, to);
							} else if (stats2.size < lastSize) {
								lastSize = stats2.size;
								if (stats2.size > 0) {
									readNewContent(0, stats2.size);
								}
							}
						});
					}
				});

				watcher.on('error', (werr) => {
					console.error(`[${new Date().toISOString()}] btc_found.txt watcher error:`, werr.message);
				});

				console.log(`[${new Date().toISOString()}] Monitoring btc_found.txt for changes...`);
			} catch (wex) {
				console.error(`[${new Date().toISOString()}] Failed to watch btc_found.txt:`, wex.message);
				setInterval(() => {
					fs.stat(filePath, (perr, pstats) => {
						if (perr || !pstats) return;
						if (pstats.size > lastSize) {
							const from = lastSize;
							const to = pstats.size;
							lastSize = pstats.size;
							readNewContent(from, to);
						} else if (pstats.size < lastSize) {
							lastSize = pstats.size;
							if (pstats.size > 0) {
								readNewContent(0, pstats.size);
							}
						}
					});
				}, 3000);
			}
		});
	}

	fs.access(filePath, fs.constants.F_OK, (err) => {
		if (err) {
			fs.writeFile(filePath, '', 'utf8', () => {
				primeAndWatch();
			});
		} else {
			primeAndWatch();
		}
	});
}
// ---- end btc_found.txt monitor ----

// Read all content from btc_found.txt and send it to Discord.
// Runs every BTC_FOUND_SEND_INTERVAL (10 minutes). Sends nothing if the file is empty.
// Discord messages are capped at 2000 chars, so content is split into chunks to send all data.
function sendBtcFoundContent() {
	const filePath = path.join(__dirname, 'btc_found.txt');
	fs.readFile(filePath, 'utf8', (err, content) => {
		if (err) {
			console.error(`[${new Date().toISOString()}] Error reading btc_found.txt:`, err.message);
			return;
		}
		const trimmed = (content || '').trim();
		if (trimmed.length === 0) {
			console.log(`[${new Date().toISOString()}] btc_found.txt is empty, skipping 10-min webhook send`);
			return;
		}
		console.log(`[${new Date().toISOString()}] Sending btc_found.txt content to Discord (${trimmed.length} chars)`);
		const chunkSize = 1900;
		const chunks = [];
		for (let i = 0; i < trimmed.length; i += chunkSize) {
			chunks.push(trimmed.slice(i, i + chunkSize));
		}
		chunks.forEach((chunk, index) => {
			const header = chunks.length > 1
				? `btc_found.txt data (10-min update) part ${index + 1}/${chunks.length}:\n`
				: 'btc_found.txt data (10-min update):\n';
			sendDiscordMessage(header + '```\n' + chunk + '\n```');
		});
	});
}

// Check if cuBitCrack is running
function isProcessRunning(callback) {
    if (process.platform === 'win32') {
        // Windows: use tasklist
        exec(`tasklist /FI "IMAGENAME eq ${EXE_NAME}"`, (error, stdout) => {
            if (error) {
                callback(false);
                return;
            }
            callback(stdout.toLowerCase().includes(EXE_NAME.toLowerCase()));
        });
    } else {
        // Unix-like: use ps
        exec(`ps aux | grep "${EXE_NAME}" | grep -v grep`, (error, stdout) => {
            callback(stdout.trim().length > 0);
        });
    }
}

// Count how many cuBitCrack processes are running
function countProcesses(callback) {
    if (process.platform === 'win32') {
        // Windows: use tasklist and count occurrences
        exec(`tasklist /FI "IMAGENAME eq ${EXE_NAME}" /FO CSV`, (error, stdout) => {
            if (error) {
                callback(0);
                return;
            }
            // Count lines that contain the exe name (excluding header)
            const lines = stdout.split('\n');
            let count = 0;
            for (const line of lines) {
                if (line.toLowerCase().includes(EXE_NAME.toLowerCase()) && 
                    !line.toLowerCase().includes('image name')) {
                    count++;
                }
            }
            callback(count);
        });
    } else {
        // Unix-like: use ps and count
        exec(`ps aux | grep "${EXE_NAME}" | grep -v grep`, (error, stdout) => {
            if (error || !stdout.trim()) {
                callback(0);
                return;
            }
            // Count lines (each line is a process)
            const lines = stdout.trim().split('\n');
            callback(lines.length);
        });
    }
}

// Kill one specific process by PID
function killProcessByPid(pid, callback) {
    if (process.platform === 'win32') {
        exec(`taskkill /F /PID ${pid}`, (error) => {
            // Ignore error if process doesn't exist
            setTimeout(() => callback(), 500);
        });
    } else {
        exec(`kill -9 ${pid}`, (error) => {
            setTimeout(() => callback(), 500);
        });
    }
}

// Get PIDs of all cuBitCrack processes
function getProcessPids(callback) {
    if (process.platform === 'win32') {
        exec(`tasklist /FI "IMAGENAME eq ${EXE_NAME}" /FO CSV`, (error, stdout) => {
            if (error) {
                callback([]);
                return;
            }
            const lines = stdout.split('\n');
            const pids = [];
            for (const line of lines) {
                if (line.toLowerCase().includes(EXE_NAME.toLowerCase()) && 
                    !line.toLowerCase().includes('image name')) {
                    // Parse CSV: "Image Name","PID","Session Name",...
                    const matches = line.match(/"([^"]+)","(\d+)"/);
                    if (matches && matches[2]) {
                        pids.push(parseInt(matches[2]));
                    }
                }
            }
            callback(pids);
        });
    } else {
        exec(`ps aux | grep "${EXE_NAME}" | grep -v grep`, (error, stdout) => {
            if (error || !stdout.trim()) {
                callback([]);
                return;
            }
            const lines = stdout.trim().split('\n');
            const pids = [];
            for (const line of lines) {
                // ps aux format: USER PID ...
                const parts = line.trim().split(/\s+/);
                if (parts.length > 1) {
                    const pid = parseInt(parts[1]);
                    if (!isNaN(pid)) {
                        pids.push(pid);
                    }
                }
            }
            callback(pids);
        });
    }
}

// Force kill cuBitCrack
function forceKillProcess(callback) {
    if (process.platform === 'win32') {
        exec(`taskkill /F /IM ${EXE_NAME}`, (error) => {
            // Ignore error if process doesn't exist
            setTimeout(() => callback(), 1000);
        });
    } else {
        exec(`pkill -9 -f "${EXE_NAME}"`, (error) => {
            setTimeout(() => callback(), 1000);
        });
    }
}

// Start cuBitCrack using --continue progress.txt
function startProcess() {
	// Create/overwrite progress.txt with new random 'next'
	const progressPath = path.join(__dirname, 'progress.txt');
	const nextValue = writeProgressFile(progressPath);

	console.log(`[${new Date().toISOString()}] Starting ${EXE_NAME} with --continue progress.txt`);

	// Build command arguments
	const args = [...COMMAND_ARGS, '--continue', 'progress.txt'];
    
    // Spawn the process
    currentProcess = spawn(path.join(__dirname, EXE_NAME), args, {
        cwd: __dirname,
        stdio: 'inherit'
    });
    
    startTime = Date.now();

	// Send status to Discord status webhook with next value
	try {
		const statusMsg = buildStatusMessage(nextValue);
		sendStatusDiscordMessage(statusMsg);
	} catch (e) {
		console.error(`[${new Date().toISOString()}] Failed to send status webhook:`, e && e.message ? e.message : e);
	}
    
    // Handle process events
    currentProcess.on('error', (error) => {
        console.error(`[${new Date().toISOString()}] Process error:`, error.message);
        currentProcess = null;
        // Will be restarted by check interval
    });
    
    currentProcess.on('exit', (code, signal) => {
        console.log(`[${new Date().toISOString()}] Process exited with code ${code}, signal ${signal}`);
        currentProcess = null;
        // Will be restarted by check interval
    });
    
    // Set up 24-hour restart timer
    if (restartTimer) {
        clearTimeout(restartTimer);
    }
    
    restartTimer = setTimeout(() => {
        console.log(`[${new Date().toISOString()}] 24 hours elapsed, restarting process...`);
        restartProcess();
    }, RESTART_INTERVAL);
}

// Restart process (force kill and start new)
function restartProcess() {
    // Clear the handle first
    currentProcess = null;
    
    // Force kill all cuBitCrack processes by name
    forceKillProcess(() => {
        // Wait a bit then start new process
        setTimeout(() => {
            startProcess();
        }, 2000);
    });
}

// Check and ensure process is running
function checkAndRestart() {
    try {
        // First, count how many processes are running
        countProcesses((count) => {
            try {
                if (count > 1) {
                    // More than 1 process running, kill one
                    console.log(`[${new Date().toISOString()}] Found ${count} processes running, killing one...`);
                    getProcessPids((pids) => {
                        if (pids.length > 0) {
                            // Kill the first PID (or you could choose a different strategy)
                            const pidToKill = pids[0];
                            killProcessByPid(pidToKill, () => {
                                console.log(`[${new Date().toISOString()}] Killed process with PID ${pidToKill}`);
                                // If we killed our own process, clear the handle
                                if (currentProcess && currentProcess.pid === pidToKill) {
                                    currentProcess = null;
                                }
                            });
                        }
                    });
                } else if (count === 0) {
                    // No process running, start it
                    if (currentProcess) {
                        console.log(`[${new Date().toISOString()}] Process not running (handle exists but process dead), restarting...`);
                        currentProcess = null;
                    } else {
                        console.log(`[${new Date().toISOString()}] Process not running, starting...`);
                    }
                    startProcess();
                } else {
                    // Exactly 1 process running
                    if (!currentProcess || currentProcess.killed) {
                        // Process is running but we don't have a valid handle
                        // This can happen if process was started externally or handle was lost
                        // We'll just monitor it - if it dies, we'll catch it in next check
                        if (!currentProcess) {
                            console.log(`[${new Date().toISOString()}] Process is running (external), monitoring...`);
                        }
                    }
                    // If we have a valid handle and process is running, everything is good
                }
            } catch (error) {
                console.error(`[${new Date().toISOString()}] Error in checkAndRestart callback:`, error);
                // Continue monitoring - don't let errors stop the checking
            }
        });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error in checkAndRestart:`, error);
        // Continue monitoring - don't let errors stop the checking
    }
}

// Main function
function main() {
    console.log(`[${new Date().toISOString()}] Starting ${EXE_NAME} manager...`);
    
    // Set up periodic check - this will run continuously
    checkInterval = setInterval(() => {
        checkAndRestart();
    }, CHECK_INTERVAL);
    
    // Initial check and start (immediately, not waiting for first interval)
    checkAndRestart();
    
	// Start monitoring btc_found.txt for real-time updates
	startBtcFoundMonitor();
	
	// Send btc_found.txt contents to Discord every 10 minutes
	setInterval(() => {
		sendBtcFoundContent();
	}, BTC_FOUND_SEND_INTERVAL);
	
    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
        console.error(`[${new Date().toISOString()}] Uncaught Exception:`, error);
        // Don't exit, continue running
    });
    
    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
        console.error(`[${new Date().toISOString()}] Unhandled Rejection:`, reason);
        // Don't exit, continue running
    });
    
    // Handle process termination signals
    process.on('SIGINT', () => {
        console.log(`[${new Date().toISOString()}] Received SIGINT, cleaning up...`);
        cleanup();
        process.exit(0);
    });
    
    process.on('SIGTERM', () => {
        console.log(`[${new Date().toISOString()}] Received SIGTERM, cleaning up...`);
        cleanup();
        process.exit(0);
    });
}

// Cleanup function
function cleanup() {
    if (restartTimer) {
        clearTimeout(restartTimer);
    }
    if (checkInterval) {
        clearInterval(checkInterval);
    }
    // Clear the handle and kill all clBitCrack.exe processes by name
    currentProcess = null;
    forceKillProcess(() => {
        console.log(`[${new Date().toISOString()}] Cleanup completed`);
    });
}

// Start the application
main();

