'use strict';

function timestamp() {
	return new Date().toISOString();
}

function log(level, ...args) {
	console.log(`[${timestamp()}] [${level}]`, ...args);
}

module.exports = {
	log,
	info: (...args) => log('INFO', ...args),
	warn: (...args) => log('WARN', ...args),
	error: (...args) => log('ERROR', ...args),
	debug: (...args) => log('DEBUG', ...args),
};
