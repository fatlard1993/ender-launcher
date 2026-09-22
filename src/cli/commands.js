import * as instanceCommands from '../commands/instances';
import * as modCommands from '../commands/mods';
import * as playCommands from '../commands/play';
import * as serveCommands from '../commands/serve';
import * as settingsCommands from '../commands/settings';

const instanceFlag = { instance: { alias: 'i', description: 'Instance to act on' } };

const depsFlag = {
	deps: { type: 'boolean', default: true, description: 'Also install required dependencies' },
	pre: { type: 'boolean', description: 'Allow alpha and beta builds, not just releases' },
};

export const commands = {
	ls: {
		summary: 'List instances',
		run: instanceCommands.ls,
	},
	new: {
		summary: 'Create an instance, optionally with mods',
		usage: 'mcm new <name> [mod...]',
		flags: {
			...depsFlag,
			minecraft: { alias: 'm', description: 'Game version, or "release" / "snapshot"' },
			loader: { alias: 'l', description: 'fabric (default), vanilla, quilt, forge, neoforge' },
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
	set: {
		summary: 'Change an instance setting',
		usage: 'mcm set [key] [value]',
		flags: instanceFlag,
		run: instanceCommands.set,
	},
	bump: {
		summary: 'Move an instance to another Minecraft version',
		usage: 'mcm bump <minecraft-version>',
		flags: { ...instanceFlag, loaderVersion: { description: 'Pin the loader instead of taking the newest' } },
		run: instanceCommands.bump,
	},
	clone: {
		summary: 'Copy an instance under a new name',
		usage: 'mcm clone <source> <new-name>',
		flags: { gameDir: { description: 'Give the copy an existing directory' } },
		run: instanceCommands.clone,
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
		summary: 'Adopt a Prism instance or a modpack',
		usage: 'mcm import <prism-instance-dir | pack.mrpack | pack.zip>',
		flags: {
			name: { description: 'Name it something other than the pack did' },
			gameDir: { description: 'Use an existing directory as the game directory' },
			minecraft: { alias: 'm', description: 'Game version, for an archive that names none' },
			loader: { alias: 'l', description: 'Loader, for an archive that names none' },
		},
		run: instanceCommands.importAny,
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
		summary: 'Java runtimes: what is here, and what Mojang publishes',
		usage: 'mcm java [install <component>]',
		flags: { refresh: { type: 'boolean', description: 'Probe again instead of using the cache' } },
		subcommands: {
			list: { summary: 'Show managed, system and installable runtimes', run: settingsCommands.javaList },
			install: { summary: "Fetch one of Mojang's runtimes", run: settingsCommands.javaInstall },
		},
		run: settingsCommands.javaList,
	},
};
