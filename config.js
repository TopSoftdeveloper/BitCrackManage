'use strict';

const path = require('path');

/**
 * Central configuration for the multi-instance BitCrack manager.
 * Edit these values before deploying to a Linux machine.
 */
const config = {
	// ------------------------------------------------------------------
	// Mode
	//   'auto' : detect NVIDIA. If found -> GPU instances, else monitor-only.
	//   'gpu'  : always run GPU instances (requires an NVIDIA GPU).
	//   'none' : never run instances, only monitor + report to Discord.
	// ------------------------------------------------------------------
	mode: 'auto',

	// CUDA BitCrack binary (Linux). Must sit next to index.js.
	gpuBinary: 'cuBitCrack',

	// ------------------------------------------------------------------
	// BitCrack arguments applied to every instance
	// ------------------------------------------------------------------
	bitcrack: {
		bits: 32,     // -b (blocks)
		threads: 256, // -t (threads per block)
		points: 16,   // -p (points)
	},

	// Number of cuBitCrack processes to spawn PER NVIDIA GPU.
	instancesPerGpu: 1,

	// ------------------------------------------------------------------
	// Shared data files (read/written by all instances)
	// ------------------------------------------------------------------
	baseDir: __dirname,
	sharedDatabase: path.join(__dirname, 'btc_database.txt'),
	sharedFound: path.join(__dirname, 'btc_found.txt'),

	// Where each instance's private workspace lives.
	instancesRoot: path.join(__dirname, 'instances'),

	// ------------------------------------------------------------------
	// Key range. Partitioned into contiguous segments so every instance
	// scans a different range.
	// ------------------------------------------------------------------
	keyRange: {
		startHex: '0000000000000000000000000000000000000000000000400000000000000000',
		endHex: '0000000000000000000000000000000000000000000003ffffffffffffffffff',
	},

	// ------------------------------------------------------------------
	// Timing (milliseconds)
	// ------------------------------------------------------------------
	restartIntervalMs: 10 * 60 * 1000,   // force-restart each instance every 10 min
	checkIntervalMs: 30 * 1000,          // health-check loop every 30 s
	foundScanIntervalMs: 5 * 1000,       // scan per-instance found files every 5 s
	foundSendIntervalMs: 10 * 60 * 1000, // full btc_found.txt Discord send every 10 min

	// ------------------------------------------------------------------
	// Discord webhooks
	// ------------------------------------------------------------------
	discordWebhook:
		'https://discord.com/api/webhooks/1539934841280135211/4c6PIuGvvr-D-HrkhfMTZa2Uxaw2urju7WkVuSwY0t5m7Nm6RabZCPfJSvhjvoUhO5c2',
	statusWebhook:
		'https://discord.com/api/webhooks/1458502651737018533/yU-GkGxttQ8L5wo6VejE9-Gmg48lLo1J4Cs0Y0Osl8u_tPl-LgcX0bouwwMgQmhXCZSc',
};

module.exports = config;
