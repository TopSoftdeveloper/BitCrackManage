'use strict';

const os = require('os');
const logger = require('./lib/logger');
const config = require('./config');
const { detectGpus } = require('./lib/gpu');
const { sendDiscordMessage, sendStatusDiscordMessage } = require('./lib/discord');
const { FoundMerger, sendSharedFoundContent } = require('./lib/found');
const Manager = require('./lib/manager');
const { formatHex64 } = require('./lib/ranges');

let manager = null;
let merger = null;

// ----------------------------------------------------------------------
// Machine info helpers
// ----------------------------------------------------------------------
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

function buildMachineInfo() {
	const cpus = os.cpus() || [];
	const cpuModel = cpus.length > 0 ? cpus[0].model : 'unknown';
	return [
		`Time: ${new Date().toISOString()}`,
		`Host: ${os.hostname()}`,
		`CPU: ${cpuModel} (${cpus.length} cores)`,
		`RAM: ${formatBytesToGiB(os.freemem())} free / ${formatBytesToGiB(os.totalmem())} total`,
		`MAC: ${getPrimaryMacAddress()}`,
	];
}

function buildStatusMessage(mode, gpus, mgr) {
	return [
		'BitCrack manager status: running',
		`Mode: ${mode === 'gpu' ? `GPU (${gpus.length} NVIDIA device(s))` : 'monitor-only (no NVIDIA GPU available)'}`,
		...buildMachineInfo(),
		`Instances: ${mgr.instances.length}`,
		...mgr.instances.map(
			(inst) =>
				`  instance ${inst.id}: device=${inst.device ?? '-'} ` +
				`range=${formatHex64(inst.segment.start)}..${formatHex64(inst.segment.end)} ` +
				`running=${inst.isRunning()}`
		),
	].join('\n');
}

// ----------------------------------------------------------------------
// Found-key handling (new keys merged into the shared btc_found.txt)
// ----------------------------------------------------------------------
function onNewFound(lines) {
	const preview = lines.join('\n');
	const trimmed = preview.length > 1800 ? preview.slice(0, 1800) + '\n...[truncated]...' : preview;
	logger.info(`New find(s) -> Discord (${lines.length} line(s))`);
	sendDiscordMessage('You became Millionaire content:\n```\n' + trimmed + '\n```');
}

// ----------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------
async function main() {
	logger.info('Starting BitCrack multi-instance manager...');
	logger.info(`Node ${process.version} on ${process.platform}/${process.arch}`);

	// 1) Detect NVIDIA GPUs
	const gpus = await detectGpus();

	// 2) Resolve mode
	let mode;
	if (config.mode === 'gpu') mode = 'gpu';
	else if (config.mode === 'none') mode = 'none';
	else mode = gpus.length > 0 ? 'gpu' : 'none';
	logger.info(`Resolved mode: ${mode}`);

	// 3) Start instances (one per GPU in GPU mode; none in monitor-only)
	manager = new Manager({ mode, gpus });
	manager.start();

	// 4) Merge per-instance found files into shared btc_found.txt + Discord
	merger = new FoundMerger({ onNewContent: onNewFound });
	for (const inst of manager.instances) {
		merger.addInstanceFoundFile(inst.id, inst.foundPath);
	}
	merger.start();

	// 5) Heartbeat: full btc_found.txt to Discord every 10 min
	setInterval(() => {
		sendSharedFoundContent();
	}, config.foundSendIntervalMs);

	// 6) Report startup status to the Discord status webhook
	const statusMsg = buildStatusMessage(mode, gpus, manager);
	logger.info(statusMsg.replace(/\n/g, ' | '));
	sendStatusDiscordMessage(statusMsg);
}

// ----------------------------------------------------------------------
// Cleanup
// ----------------------------------------------------------------------
async function cleanup() {
	logger.info('Shutting down...');
	if (merger) merger.stop();
	if (manager) await manager.stop();
	logger.info('Cleanup completed');
	process.exit(0);
}

process.on('uncaughtException', (error) => {
	logger.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason) => {
	logger.error('Unhandled Rejection:', reason);
});

process.on('SIGINT', () => cleanup());
process.on('SIGTERM', () => cleanup());

main();

