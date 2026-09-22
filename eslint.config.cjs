const globals = require('globals');
const vanillaBeanEslint = require('@vanilla-bean/components/eslint.config.cjs');
const vanillaBeanSpellcheck = require('@vanilla-bean/components/spellcheck.config.cjs');
const localSpellcheck = require('./spellcheck.config.cjs');

module.exports = [
	...vanillaBeanEslint,
	{
		rules: {
			'spellcheck/spell-checker': [
				'warn',
				{
					...vanillaBeanSpellcheck,
					...localSpellcheck,
					skipWords: [...vanillaBeanSpellcheck.skipWords, ...localSpellcheck.skipWords],
					skipIfMatch: [...vanillaBeanSpellcheck.skipIfMatch, ...(localSpellcheck.skipIfMatch ?? [])],
				},
			],
		},
	},
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
			'jsdoc/require-jsdoc': 'off',
			'jsdoc/require-param': 'off',
			'jsdoc/require-param-description': 'off',
			'jsdoc/require-param-type': 'off',
			'jsdoc/require-returns': 'off',
			'jsdoc/require-returns-description': 'off',
		},
	},
	{
		// A word list read as prose is a word list that flags itself.
		files: ['spellcheck.config.cjs'],
		rules: { 'spellcheck/spell-checker': 'off' },
	},
];
