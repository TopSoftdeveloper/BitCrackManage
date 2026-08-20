'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('./logger');
const { sendDiscordMessage } = require('./discord');

/**
 * Watches every instance's private found file, merges new lines into the
 * shared btc_found.txt (deduplicated) and reports new finds to Discord.
 */
class FoundMerger {
	constructor({ onNewContent } = {}) {
		this.sharedFile = config.sharedFound;
		this.onNewContent = onNewContent || (() => {});
		this.instanceFiles = new Map(); // absPath -> { instanceId, offset }
		this.seenLines = new Set();
		this.timer = null;
		this.scanIntervalMs = config.foundScanIntervalMs;
	}

	addInstanceFoundFile(instanceId, absPath) {
		this.instanceFiles.set(absPath, { instanceId, offset: 0 });
		// Seed the seen-lines set from the shared file so keys that are
		// already in btc_found.txt are never re-sent or duplicated.
		this._seedSeenLines();
	}

	_seedSeenLines() {
		try {
			const content = fs.readFileSync(this.sharedFile, 'utf8');
			for (const line of content.split('\n')) {
				const t = line.trim();
				if (t) this.seenLines.add(t);
			}
		} catch (err) {
			// shared file may not exist yet - fine
		}
	}

	start() {
		if (!fs.existsSync(this.sharedFile)) {
			fs.writeFileSync(this.sharedFile, '', 'utf8');
		}
		this.timer = setInterval(() => this._scan(), this.scanIntervalMs);
		this._scan();
		logger.info('Found-file merger started (watching per-instance found files).');
	}

	stop() {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	_scan() {
		for (const [file, state] of this.instanceFiles) {
			let size = 0;
			try {
				size = fs.statSync(file).size;
			} catch (err) {
				continue; // file not created yet
			}

			if (size < state.offset) {
				// File was truncated/rewritten - rescan from the top.
				state.offset = 0;
			}
			if (size <= state.offset) continue;

			const buffer = Buffer.alloc(size - state.offset);
			const fd = fs.openSync(file, 'r');
			try {
				fs.readSync(fd, buffer, 0, buffer.length, state.offset);
			} finally {
				fs.closeSync(fd);
			}
			state.offset = size;

			const newLines = buffer
				.toString('utf8')
				.split('\n')
				.map((l) => l.trim())
				.filter((l) => l.length > 0 && !this.seenLines.has(l));

			for (const line of newLines) {
				this.seenLines.add(line);
				this._appendShared(line);
			}

			if (newLines.length > 0) {
				logger.info(
					`Merged ${newLines.length} new find(s) from ${path.basename(file)} into ${path.basename(this.sharedFile)}`
				);
				this.onNewContent(newLines);
			}
		}
	}

	_appendShared(line) {
		try {
			fs.appendFileSync(this.sharedFile, line + '\n', 'utf8');
		} catch (err) {
			logger.error('Failed to append to shared btc_found.txt:', err.message);
		}
	}
}

/**
 * Send the full shared btc_found.txt content to Discord, split into
 * sub-2000-char chunks. Sends nothing if the file is empty.
 */
function sendSharedFoundContent() {
	return new Promise((resolve) => {
		fs.readFile(config.sharedFound, 'utf8', (err, content) => {
			if (err) {
				logger.error('Error reading btc_found.txt:', err.message);
				return resolve();
			}
			const trimmed = (content || '').trim();
			if (trimmed.length === 0) {
				logger.info('btc_found.txt is empty, skipping 10-min webhook send');
				return resolve();
			}
			logger.info(`Sending btc_found.txt content to Discord (${trimmed.length} chars)`);

			const chunkSize = 1900;
			const chunks = [];
			for (let i = 0; i < trimmed.length; i += chunkSize) {
				chunks.push(trimmed.slice(i, i + chunkSize));
			}

			const sends = chunks.map((chunk, index) => {
				const header =
					chunks.length > 1
						? `btc_found.txt data (10-min update) part ${index + 1}/${chunks.length}:\n`
						: 'btc_found.txt data (10-min update):\n';
				return sendDiscordMessage(header + '```\n' + chunk + '\n```');
			});
			Promise.all(sends).then(resolve);
		});
	});
}

module.exports = { FoundMerger, sendSharedFoundContent };
