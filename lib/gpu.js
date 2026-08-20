'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const execFileP = promisify(execFile);

/**
 * Detect available NVIDIA GPUs.
 *
 * Strategy (first success wins):
 *   1. `nvidia-smi -L`            (Linux + Windows when the NVIDIA driver is installed)
 *   2. `/proc/driver/nvidia/gpus` (Linux, driver loaded but nvidia-smi not in PATH)
 *   3. `cudaInfo.exe`             (Windows fallback if shipped next to the manager)
 *
 * @returns {Promise<Array<{index: number|null, label: string}>>}
 *          Empty array when no usable NVIDIA GPU is present.
 */
async function detectGpus() {
	// 1) nvidia-smi -L
	try {
		const { stdout } = await execFileP('nvidia-smi', ['-L'], { timeout: 10000 });
		const lines = stdout
			.split('\n')
			.map((l) => l.trim())
			.filter(Boolean);
		if (lines.length > 0) {
			const gpus = lines.map((line) => {
				const m = line.match(/GPU\s+(\d+):/);
				return { index: m ? parseInt(m[1], 10) : null, label: line };
			});
			logger.info(`NVIDIA detected via nvidia-smi: ${gpus.length} GPU(s)`);
			return gpus;
		}
	} catch (err) {
		logger.debug(`nvidia-smi not available: ${err.message}`);
	}

	// 2) Linux driver proc interface
	if (process.platform === 'linux') {
		try {
			const dirs = fs.readdirSync('/proc/driver/nvidia/gpus');
			if (dirs.length > 0) {
				logger.info(`NVIDIA detected via /proc/driver/nvidia/gpus: ${dirs.length} GPU(s)`);
				return dirs.map((label, i) => ({ index: i, label }));
			}
		} catch (err) {
			logger.debug(`/proc/driver/nvidia/gpus not present: ${err.message}`);
		}
	}

	// 3) Windows fallback: cudaInfo.exe shipped next to the manager
	if (process.platform === 'win32') {
		try {
			const exe = path.join(__dirname, '..', 'cudaInfo.exe');
			const { stdout } = await execFileP(exe, [], { timeout: 10000 });
			const lines = stdout
				.split('\n')
				.map((l) => l.trim())
				.filter(Boolean);
			if (lines.length > 0) {
				logger.info(`NVIDIA detected via cudaInfo.exe`);
				return lines.map((label, i) => ({ index: i, label }));
			}
		} catch (err) {
			logger.debug(`cudaInfo.exe not available: ${err.message}`);
		}
	}

	logger.info('No NVIDIA GPU detected on this machine.');
	return [];
}

module.exports = { detectGpus };
