'use strict';

const https = require('https');
const config = require('../config');
const logger = require('./logger');

/** POST a message to a Discord webhook. Always resolves (never rejects). */
function postDiscord(urlString, message) {
	return new Promise((resolve) => {
		try {
			const data = JSON.stringify({ content: message });
			const url = new URL(urlString);
			const options = {
				method: 'POST',
				hostname: url.hostname,
				path: url.pathname + url.search,
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(data),
				},
			};

			const req = https.request(options, (res) => {
				res.on('data', () => {});
				res.on('end', () => resolve());
			});

			req.on('error', (err) => {
				logger.error('Discord webhook error:', err.message);
				resolve();
			});

			req.write(data);
			req.end();
		} catch (err) {
			logger.error('Discord webhook exception:', err);
			resolve();
		}
	});
}

function sendDiscordMessage(message) {
	return postDiscord(config.discordWebhook, message);
}

function sendStatusDiscordMessage(message) {
	return postDiscord(config.statusWebhook, message);
}

module.exports = { postDiscord, sendDiscordMessage, sendStatusDiscordMessage };
