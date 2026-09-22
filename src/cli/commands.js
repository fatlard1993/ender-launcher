import * as instanceCommands from '../commands/instances';
import * as modCommands from '../commands/mods';
import * as playCommands from '../commands/play';
import * as serveCommands from '../commands/serve';
import * as settingsCommands from '../commands/settings';

const instanceFlag = { instance: { alias: 'i', description: 'Instance to act on' } };

const depsFlag = { deps: { type: 'boolean', default: true, description: 'Also install required dependencies' } };

export const commands = {
	ls: {
		summary: 'List instances',
		run: instanceCommands.ls,
	},
	new: {
		summary: 'Create an instance',
		usage: 'mcm new <name>',
		flags: {
			minecraft: { alias: 'm', description: 'Game version, or "release" / "snapshot"' },
			loader: { alias: 'l', description: 'fabric (default) or vanilla' },
			loaderVersion: { description: 'Pin the loader version' },
			gameDir: { description: 'Use an existing directory as the game directory' },
			server: { type: 'boolean', description: 'Make it a server instance' },
		},
		run: instanceCommands.create,
	},
	use: {
		summary: 'Set the active instance',
		usage: 'mcm use <name>',
		run: instanceCommands.use,
	},
	info: {
		summary: 'Show an instance and its mods',
		usage: 'mcm info [name]',
		flags: instanceFlag,
		run: instanceCommands.info_,
	},
	delete: {
		summary: 'Delete an instance',
		usage: 'mcm delete <name> [--purge] [--yes]',
		flags: {
			...instanceFlag,
			purge: { type: 'boolean', description: 'Delete the game directory too' },
			yes: { type: 'boolean', alias: 'y', description: 'Skip the confirmation' },
		},
		run: instanceCommands.remove,
	},
	import: {
		summary: 'Adopt a Prism Launcher instance',
		usage: 'mcm import <prism-instance-directory>',
		flags: { name: { description: 'Name it something other than Prism did' } },
		run: instanceCommands.importPrism,
	},

	install: {
		summary: 'Download everything an instance needs, without launching',
		usage: 'mcm install [name]',
		flags: { ...instanceFlag, assets: { type: 'boolean', default: true, description: 'Include game assets' } },
		run: playCommands.install,
	},
	launch: {
		summary: 'Launch an instance',
		usage: 'mcm launch [name]',
		flags: {
			...instanceFlag,
			install: { type: 'boolean', default: true, description: 'Verify files before launching' },
			assets: { type: 'boolean', default: true, description: 'Include game assets' },
			dryRun: { type: 'boolean', description: 'Print the java command instead of running it' },
		},
		run: playCommands.play,
	},
	explain: {
		summary: 'Show what would be launched and where each piece comes from',
		usage: 'mcm explain [name]',
		flags: instanceFlag,
		run: playCommands.explain,
	},

	search: {
		summary: 'Search Modrinth and CurseForge',
		usage: 'mcm search <query>',
		flags: {
			...instanceFlag,
			source: { alias: 's', description: 'modrinth or curseforge' },
			minecraft: { alias: 'm', description: 'Narrow to a game version' },
			loader: { alias: 'l', description: 'Narrow to a loader' },
			limit: { type: 'number', alias: 'n', default: 8, description: 'Results per source' },
			any: { type: 'boolean', description: 'Do not narrow by the active instance' },
		},
		run: modCommands.search,
	},
	add: {
		summary: 'Add mods to an instance',
		usage: 'mcm add <mod> [mod...]',
		flags: { ...instanceFlag, ...depsFlag },
		run: modCommands.add,
	},
	drop: {
		summary: 'Remove mods from an instance',
		usage: 'mcm drop <mod> [mod...]',
		flags: { ...instanceFlag, ...depsFlag },
		run: modCommands.drop,
	},
	sync: {
		summary: 'Make the mods directory match the manifest',
		usage: 'mcm sync [--instance name]',
		flags: { ...instanceFlag, ...depsFlag },
		run: modCommands.sync,
	},
	update: {
		summary: 'Move mods to the newest compatible build',
		usage: 'mcm update [mod...]',
		flags: { ...instanceFlag, ...depsFlag },
		run: modCommands.update,
	},

	server: {
		summary: 'Server instance management',
		usage: 'mcm server <provision|start|offline|status>',
		flags: instanceFlag,
		subcommands: {
			provision: { summary: 'Download the Fabric server launcher', run: serveCommands.provision },
			start: { summary: 'Run the server in the foreground', run: serveCommands.start },
			offline: { summary: 'Set online-mode=false so offline clients can join', run: serveCommands.offline },
			status: { summary: 'Show the server instance', run: serveCommands.status },
		},
	},

	config: {
		summary: 'Read or write global settings',
		usage: 'mcm config [key] [value]',
		run: settingsCommands.config,
	},
	java: {
		summary: 'List the Java installations that were found',
		flags: { refresh: { type: 'boolean', description: 'Probe again instead of using the cache' } },
		run: settingsCommands.java,
	},
};
