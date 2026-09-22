# minecraft-manager

Minecraft instances, mods, and servers from the command line. `mcm` for short.

## Why

Prism Launcher does four things that matter: it resolves version metadata, downloads libraries and assets, signs you in, and builds the java command. Everything else about an instance already lives in a directory you own.

One of those four costs you. Prism does not ship version data; it fetches it from `meta.prismlauncher.org`, and that service ingests a new snapshot some days after Mojang publishes it. In between, an instance pinned to that version will not launch at all, while the official launcher plays it fine.

This reads Mojang's manifest and Fabric's meta directly. There is no mirror to wait for, so the lag never happens and there is nothing to patch around.

## Getting started

```
bun install
bun link            # puts `mcm` on your PATH
```

If you have a Prism instance already, adopt it rather than rebuild it:

```
mcm import ~/.local/share/PrismLauncher/instances/suite
mcm config username <your-name>
mcm launch
```

Import reads the version and loader out of `mmc-pack.json`, follows `.minecraft` to wherever it really points, and asks Modrinth to identify the jars already in `mods/`. What it recognizes becomes a declared mod. What it does not recognize is listed and then left exactly where it is.

Otherwise, start fresh:

```
mcm new suite --minecraft 26.3
mcm add fabric-api sodium
mcm launch
```

## Accounts

Launching is offline only. The player UUID is derived from the name the way vanilla derives it, so worlds and inventories follow the name and a save made under an online account still knows you.

An offline client cannot join a server running `online-mode=true`. For a server this tool manages, `mcm server offline` turns that off, and a newly provisioned server is set that way from the start. For someone else's server, offline is simply not going to work, and that is not something a launcher can fix.

## Instances

An instance is a manifest and a game directory, nothing more:

```
mcm ls                     list them, with the active one marked
mcm new <name>             create one
mcm use <name>             set the active one, so later commands need no --instance
mcm info                   what it is and what is installed
mcm explain                the launch plan, and where each piece of it came from
mcm delete <name>          remove it; --purge takes the game directory too
```

The game directory is the instance's own by default, but `--game-dir` points at a directory you already have. A working tree is a perfectly good game directory.

## Mods

```
mcm search sodium          Modrinth, narrowed to the active instance
mcm add sodium cf:jei      add and install
mcm drop sodium            remove from the manifest and from disk
mcm sync                   make mods/ match the manifest
mcm update                 move to the newest compatible builds
```

A mod is written one of these ways:

| Written                                         | Source                                |
| ----------------------------------------------- | ------------------------------------- |
| `sodium`                                        | Modrinth, the default for a bare name |
| `modrinth:sodium@0.5.8` or `mr:sodium`          | Modrinth, optionally pinned           |
| `cf:jei` or `curseforge:jei@<file name>`        | CurseForge                            |
| `gh:FabricMC/fabric` or `github:owner/repo@tag` | a GitHub release                      |
| `./build/libs/mod.jar`                          | a jar on disk                         |
| `https://example.com/mod.jar`                   | a direct download                     |

Required dependencies come along unless you pass `--no-deps`.

### The file

The manifest is the file, and `mcm add` is only a way of editing it. Instance state lives in `instances/<name>/instance.json`:

```json
{
	"name": "suite",
	"minecraft": "26.3",
	"loader": { "type": "fabric", "version": "0.19.5" },
	"gameDir": "/home/you/Projects/minecraft-client",
	"mods": [
		{ "source": "modrinth", "id": "fabric-api", "version": "0.160.6+26.3" },
		{ "source": "curseforge", "id": "jei" },
		{ "source": "github", "id": "FabricMC/fabric", "asset": "fabric-api" },
		{ "source": "local", "path": "../minecraft/pandorical/build/libs/pandorical-15.3.1.jar" }
	]
}
```

Edit it by hand and run `mcm sync`. An entry without a `version` floats to the newest compatible build; one with a version stays put until `mcm update` releases it.

Alongside it, `instance.lock.json` records what was actually installed, including the checksum each source published. That is what makes removal safe: **sync only deletes files a previous sync put there.** A jar you dropped in by hand is reported and left alone, every time.

### CurseForge without a key

CurseForge works with no API key at all. Their project pages are behind Cloudflare and answer a scraper with 403, but two things are reachable: their own site API lists a project's files, and a public mirror turns a slug into a project id. A file's download url is then derived from its id.

That derivation is exact and unforgiving. The remainder is not padded, so file `8880075` lives under `8880/75` and `8880/075` is refused; the name must be percent-escaped, so a literal `+` is refused where `%2B` is served, and `+` is ordinary in a Fabric jar name. Both rules are pinned by tests against real files.

What you give up without a key is a checksum, because the keyless route publishes none. Downloads are verified by size alone. There is also no keyless search: CurseForge publishes none, so `mcm search --source curseforge` looks the query up as an exact slug and says so.

Setting `mcm config curseforgeKey <key>` with a key from [their console](https://console.curseforge.com/) switches to the official API, which restores search, checksums, and declared dependencies.

### GitHub releases

`mcm add gh:owner/repo` takes the newest release that ships a jar; `@tag` pins one. Release assets carry a sha256 digest, so these are verified properly.

Picking the jar takes some care, because a Gradle release usually ships the artifact alongside its sources and javadoc. Those are skipped, then a jar naming the game version wins, then the shortest name, which is the plain artifact rather than a variant. When a release ships several real jars, an `asset` pattern in the manifest entry settles it, and the error tells you what the release actually contains.

Unauthenticated GitHub allows sixty requests an hour. `mcm config githubToken <token>` raises that, `GITHUB_TOKEN` is read if set, and otherwise the `gh` CLI is asked for its own token.

## Servers

```
mcm new world --server --minecraft 26.3
mcm server provision       fetch the Fabric server launcher
mcm server start           run it in the foreground
mcm server offline         set online-mode=false
mcm server status          version, port, online-mode, what is installed
```

Mods sync into a server instance exactly as they do into a client one.

## Java

Runtimes are found by asking each binary its version rather than by reading its path, because paths lie. The version's own `javaVersion` decides which one is used; `mcm java` lists what was found, and `mcm config javaPath <path>` overrides the choice.

## Caches

Libraries and assets are shared across instances, under `~/.local/share/minecraft-manager`. On the first install, any file another launcher already has is hardlinked rather than downloaded, so adopting a Prism setup costs close to nothing in either bandwidth or disk. Set `MCM_HOME` to put everything somewhere else.

## Tests

```
bun test
```

## License

ISC.
