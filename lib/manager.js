'use strict';

const path = require('path');
const config = require('../config');
const logger = require('./logger');
const Instance = require('./instance');
const { partitionRange, formatHex64 } = require('./ranges');

/**
 * Owns the set of running instances and keeps them alive.
 *
 *   mode 'gpu' : one Instance per NVIDIA GPU (each bound to a device + range)
 *   mode 'none': no instances (monitor-only)
 */
class Manager {
	constructor({ mode, gpus }) {
		this.mode = mode; // 'gpu' | 'none'
		this.gpus = gpus || [];
		this.instances = [];
		this.checkTimer = null;
	}

	buildInstances() {
		// Decide the instance specs based on the resolved mode.
		const specs = [];
		if (this.mode === 'gpu') {
			for (const gpu of this.gpus) {
				for (let k = 0; k < config.instancesPerGpu; k++) {
					specs.push({ device: gpu.index });
				}
			}
		}
		// mode 'none' -> specs stays empty (no instances).

		// Split the key range so each instance scans a different range.
		const segments = partitionRange(specs.length);
		const binaryPath = path.join(config.baseDir, config.gpuBinary);

		this.instances = specs.map((spec, i) => {
			return new Instance({
				id: i,
				workspaceDir: path.join(config.instancesRoot, `instance_${i}`),
				binaryPath,
				segment: segments[i],
				device: spec.device,
			});
		});

		logger.info(`Manager built ${this.instances.length} instance(s) (mode: ${this.mode}).`);
	}

	start() {
		this.buildInstances();
		if (this.instances.length === 0) {
			logger.warn('No instances to start (no NVIDIA GPU available - monitor-only mode).');
		}
		for (const inst of this.instances) {
			inst.start();
		}
		this.checkTimer = setInterval(() => this.checkAll(), config.checkIntervalMs);
	}

	/** Health check: restart any instance that has stopped. */
	checkAll() {
		for (const inst of this.instances) {
			if (!inst.isRunning()) {
				logger.warn(`[instance ${inst.id}] Not running, restarting...`);
				inst.start();
			}
		}
	}

	async stop() {
		if (this.checkTimer) {
			clearInterval(this.checkTimer);
			this.checkTimer = null;
		}
		await Promise.all(this.instances.map((i) => i.stop()));
		this.instances = [];
	}

	summary() {
		const lines = [
			`Mode: ${this.mode === 'gpu' ? `GPU (${this.gpus.length} NVIDIA device(s))` : 'monitor-only (no NVIDIA GPU)'}`,
			`Instances: ${this.instances.length}`,
		];
		for (const inst of this.instances) {
			lines.push(
				`  instance ${inst.id}: device=${inst.device ?? '-'} ` +
					`range=${formatHex64(inst.segment.start)}..${formatHex64(inst.segment.end)} ` +
					`running=${inst.isRunning()}`
			);
		}
		return lines.join('\n');
	}
}

module.exports = Manager;
