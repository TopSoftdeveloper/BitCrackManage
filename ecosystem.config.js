module.exports = {
	apps: [
		{
			name: 'cubitcrack',
			script: 'index.js',
			cwd: __dirname,
			autorestart: true,
			watch: false,
			windowsHide: true,
			merge_logs: true,
			time: true
		}
	]
};
