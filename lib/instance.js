'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('./logger');
const { formatHex64, buildProgressFile, parseProgressNext } = require('./ranges');

/**
 * A single cuBitCrack worker.
 *
 * Each instance owns:
 *   - its own workspace directory (instances/instance_<id>/)
 *   - its own progress.txt (resumes where it left off)
 *   - its own found output file (btc_found_<id>.txt) merged by FoundMerger
 *
 * Restart/stop only ever kills its OWN child PID, never by binary name, so
 * multiple instances running in parallel cannot kill each other.
 */
class Instance {
	constructor({ id, workspaceDir, binaryPath, segment, device }) {
		this.id = id;
		this.workspaceDir = workspaceDir;
		this.binaryPath = binaryPath;
		this.segment = segment; // { start, end } BigInt
		this.device = device; // GPU device index, or null

		this.progressPath = path.join(this.workspaceDir, 'progress.txt');
		this.foundPath = path.join(this.workspaceDir, `btc_found_${this.id}.txt`);

		this.child = null;
		this.startTime = null;
		this.restartTimer = null;
		this.running = false;
	}

	ensureWorkspace() {
		fs.mkdirSync(this.workspaceDir, { recursive: true });
		if (!fs.existsSync(this.foundPath)) {
			fs.writeFileSync(this.foundPath, '', 'utf8');
		}
	}

	_prepareProgress() {
		// Resume from an existing, in-range progress file; otherwise write a
		// fresh progress.txt bound to this instance's segment.
		try {
			const content = fs.readFileSync(this.progressPath, 'utf8');
			const next = parseProgressNext(content);
			if (next !== null && next >= this.segment.start && next <= this.segment.end) {
				logger.info(`[instance ${this.id}] Resuming from ${formatHex64(next)}`);
				return;
			}
		} catch (err) {
			// no progress file yet - fall through and create one
		}

		const content = buildProgressFile(this.segment);
		fs.writeFileSync(this.progressPath, content, 'utf8');
		logger.info(
			`[instance ${this.id}] Wrote new progress.txt (range ${formatHex64(this.segment.start)}..${formatHex64(this.segment.end)})`
		);
	}

	buildArgs() {
		const args = [
			'-b', String(config.bitcrack.bits),
			'-t', String(config.bitcrack.threads),
			'-p', String(config.bitcrack.points),
			'-i', config.sharedDatabase,
			'-o', this.foundPath,
		];
		if (this.device !== undefined && this.device !== null) {
			args.push('-d', String(this.device));
		}
		args.push('--continue', this.progressPath);
		return args;
	}

	start() {
		this.ensureWorkspace();
		this._prepareProgress();

		const args = this.buildArgs();
		logger.info(`[instance ${this.id}] Starting ${path.basename(this.binaryPath)} ${args.join(' ')}`);

		try {
			this.child = spawn(this.binaryPath, args, {
				cwd: this.workspaceDir,
				stdio: 'inherit',
			});
		} catch (err) {
			logger.error(`[instance ${this.id}] Failed to spawn:`, err.message);
			this.child = null;
			this.running = false;
			return;
		}

		this.running = true;
		this.startTime = Date.now();

		this.child.on('error', (err) => {
			logger.error(`[instance ${this.id}] Process error:`, err.message);
			this.child = null;
			this.running = false;
		});

		this.child.on('exit', (code, signal) => {
			logger.warn(`[instance ${this.id}] Exited with code ${code}, signal ${signal}`);
			this.child = null;
			this.running = false;
		});

		// Periodic force-restart so the instance keeps rotating through keys.
		this.restartTimer = setTimeout(() => {
			logger.info(`[instance ${this.id}] Restart timer fired, restarting...`);
			this.restart();
		}, config.restartIntervalMs);
	}

	isRunning() {
		return this.running && this.child !== null && !this.child.killed;
	}

	restart() {
		if (this.restartTimer) {
			clearTimeout(this.restartTimer);
			this.restartTimer = null;
		}
		const old = this.child;
		this.child = null;
		this.running = false;
		this._kill(old, () => {
			setTimeout(() => this.start(), 2000);
		});
	}

	_kill(child, callback) {
		if (child && typeof child.kill === 'function') {
			try {
				child.kill('SIGKILL');
			} catch (err) {
				logger.warn(`[instance ${this.id}] kill failed:`, err.message);
			}
		}
		setTimeout(() => callback(), 500);
	}

	stop() {
		if (this.restartTimer) {
			clearTimeout(this.restartTimer);
			this.restartTimer = null;
		}
		const old = this.child;
		this.child = null;
		this.running = false;
		return new Promise((resolve) => {
			this._kill(old, resolve);
		});
	}
}

module.exports = Instance;
