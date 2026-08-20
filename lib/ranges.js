'use strict';

const crypto = require('crypto');
const config = require('../config');

const KEY_RANGE_START = BigInt('0x' + config.keyRange.startHex);
const KEY_RANGE_END = BigInt('0x' + config.keyRange.endHex);
const KEY_RANGE_SIZE = KEY_RANGE_END - KEY_RANGE_START + 1n;

/** Format a BigInt as a 64-char zero-padded uppercase hex string. */
function formatHex64(value) {
	return value.toString(16).toUpperCase().padStart(64, '0');
}

/** Random BigInt in [0, limit). */
function randomBigInt(limit) {
	const bytes = crypto.randomBytes(32);
	const v = BigInt('0x' + bytes.toString('hex'));
	return v % limit;
}

/**
 * Split [KEY_RANGE_START, KEY_RANGE_END] into `count` contiguous,
 * non-overlapping segments so every instance scans a different range.
 *
 * @returns {Array<{index: number, start: bigint, end: bigint}>}
 */
function partitionRange(count) {
	if (count <= 0) return [];
	const segments = [];
	const segSize = KEY_RANGE_SIZE / BigInt(count);
	let cur = KEY_RANGE_START;
	for (let i = 0; i < count; i++) {
		const start = cur;
		const end = i === count - 1 ? KEY_RANGE_END : start + segSize - 1n;
		segments.push({ index: i, start, end });
		cur = end + 1n;
	}
	return segments;
}

/**
 * Build the content of a progress.txt for one range segment.
 * `next` is randomized inside the segment (like the original script) unless a
 * valid preserved `next` value is passed in (used to resume after restarts).
 */
function buildProgressFile(segment, opts = {}) {
	const startHex = formatHex64(segment.start);
	const endHex = formatHex64(segment.end);
	const hasNext = opts.next !== undefined && opts.next >= segment.start && opts.next <= segment.end;
	const nextHex = hasNext
		? formatHex64(opts.next)
		: formatHex64(segment.start + randomBigInt(segment.end - segment.start + 1n));

	return [
		`start=${startHex}`,
		`next=${nextHex}`,
		`end=${endHex}`,
		`blocks=${config.bitcrack.bits}`,
		`threads=${config.bitcrack.threads}`,
		`points=${config.bitcrack.points}`,
		'compression=compressed',
		'device=0',
		'elapsed=0',
		`stride=${formatHex64(1n)}`,
	].join('\n');
}

/** Parse the `next=` value out of a progress.txt file, or return null. */
function parseProgressNext(content) {
	const m = String(content || '').match(/next=([0-9A-Fa-f]{64})/);
	return m ? BigInt('0x' + m[1]) : null;
}

module.exports = {
	KEY_RANGE_START,
	KEY_RANGE_END,
	KEY_RANGE_SIZE,
	formatHex64,
	partitionRange,
	buildProgressFile,
	parseProgressNext,
};
