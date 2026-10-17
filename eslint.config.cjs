const globals = require('globals');

module.exports = [
	...require('@vanilla-bean/components/eslint.app.config.cjs'),
	{
		files: ['index.js', 'src/**/*.js', 'test/**/*.js'],
		languageOptions: {
			globals: {
				...globals.node,
				Bun: true,
			},
		},
		rules: {
			// A command line tool talks to the terminal; that is its whole output surface.
			'no-console': 'off',
			'compat/compat': 'off',
		},
	},
];
