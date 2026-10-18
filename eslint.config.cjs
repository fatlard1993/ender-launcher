const globals = require('globals');

module.exports = [
	...require('@vanilla-bean/components/eslint.app.config.cjs'),
	{
		// The app profile gives test/ node globals; this is a command line tool all through, src/ and index.js too
		files: ['index.js', 'src/**/*.js'],
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
