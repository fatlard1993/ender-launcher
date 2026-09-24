# ender-launcher

Minecraft instances, mods, and servers from the command line. `ender` for short.

## Why

Prism Launcher does four things that matter: it resolves version metadata, downloads libraries and assets, signs you in, and builds the java command. Everything else about an instance already lives in a directory you own.

One of those four costs you. Prism does not ship version data; it fetches it from `meta.prismlauncher.org`, and that service ingests a new snapshot some days after Mojang publishes it. In between, an instance pinned to that version will not launch at all, while the official launcher plays it fine.

This reads Mojang's manifest and Fabric's meta directly. There is no mirror to wait for, so the lag never happens and there is nothing to patch around.

## Getting started

```
bun install
bun link            # puts `ender` on your PATH
```

If you have a modpack, start from it:

```
ender import pack.mrpack
ender sync
ender launch
```

If you have a Prism instance already, adopt it rather than rebuild it:

```
ender import ~/.local/share/PrismLauncher/instances/suite
ender config username <your-name>
ender launch
```

Import reads the version and loader out of `mmc-pack.json`, follows `.minecraft` to wherever it really points, and asks Modrinth to identify the jars already in `mods/`. What it recognizes becomes a declared mod. What it does not recognize is listed and then left exactly where it is.

## Packs

`ender import` takes a pack as readily as an instance, and decides which kind it is by looking inside rather than at the extension:

| Shape | What it carries | What import does |
| --- | --- | --- |
| Modrinth `.mrpack` | `modrinth.index.json` + `overrides/` | version, loader, and each referenced file as a checksummed mod entry |
| CurseForge `.zip` | `manifest.json` + `overrides/` | version, loader, and each mod by project and file id |
| A plain zip of jars | jars, and nothing else | lays them in `mods/`; needs `--minecraft`, because nothing in it says |

Whatever a pack carries as loose files is unpacked into the game directory, then offered to Modrinth by hash. A bundled jar that turns out to be a published mod becomes a declared, updatable entry; one that does not is listed and left alone, the same as any jar you dropped in yourself. A pack's `client`/`server` markings are honored, so importing a pack into a server instance leaves out what it says is client-only.

Otherwise, start fresh. `new` takes mods, so an instance and its contents are one command:

```
ender new suite fabric-api sodium
ender launch suite
```

With no flags at all, `ender new suite` is the newest release on the newest stable Fabric loader, both resolved live. Mods named on the line are resolved before the instance is created, so a typo leaves nothing behind to clean up, and anything they require comes along with them.

## Accounts

```
ender account                    who you can play as
ender account add --offline Bob  an identity that needs no sign in
ender account add                sign in to a Microsoft account
ender account use <name>         choose which one instances play as
ender account assign <name>      bind one instance to one account
```

An account is either offline or Microsoft, and the two sit in one list and switch the same way. An offline one is a name and the uuid vanilla derives from it, so it is exactly the player a bare username would have been, only one you can keep several of and move between. That is what makes testing your own multiplayer worth doing locally: two instances, two names, two uuids, one `online-mode=false` server.

Sign in is the Microsoft device code flow: ender shows a short code, you type it into a browser, and the tokens live in `accounts.json` with owner-only permissions. A Minecraft token lasts a day and is renewed from the Microsoft one when it goes stale, so signing in is a thing you do once.

**Signing in needs an Azure app registration of your own, and getting one approved is the hard part.** A new registration cannot use the Minecraft API until Microsoft reviews it, and there is no route designed for an individual: the documented answer points at the Xbox Developer program, which expects you to be shipping a game. Register an application in Microsoft Entra ID, add a mobile and desktop platform, allow public client flows, apply at <https://aka.ms/mce-reviewappid>, then `ender config clientId <the application id>`. Until it is approved, Minecraft answers the sign in with a 403 and ender says so plainly rather than leaving you to guess.

Without an account, instances launch offline. The player UUID is derived from the name the way vanilla derives it, so worlds and inventories follow the name and a save made under an online account still knows you. A failed sign in is an error rather than a silent downgrade: a token that cannot be renewed is worth hearing about, not quietly swapping you into a game that cannot join anything.

An offline client cannot join a server running `online-mode=true`. For a server this tool manages, `ender server offline` turns that off, and a newly provisioned server is set that way from the start.

## Instances

An instance is a manifest and a game directory, nothing more:

```
ender ls                     list them, with the active one marked
ender new <name> [mod...]    create one, optionally with mods
ender use <name>             set the active one, so later commands need no --instance
ender info                   what it is and what is installed
ender set [key] [value]      change a setting; bare `ender set` lists what is settable
ender bump <version>         move to another Minecraft version, carrying the loader
ender clone <src> <name>     copy one under a new name
ender explain                the launch plan, and where each piece of it came from
ender delete <name>          remove it; --purge takes the game directory too
```

Only the mod list used to be changeable after creation. `ender bump 26.4` moves an instance to a new snapshot and re-resolves the loader with it, which is the whole of what a version bump takes.

The game directory is the instance's own by default, but `--game-dir` points at a directory you already have. A working tree is a perfectly good game directory.

`--loader` takes `fabric` (the default) or `vanilla`. Quilt, Forge and NeoForge each need their own loader metadata and launch shape, so naming one is refused rather than quietly answered with a vanilla launch.

## Mods

```
ender search sodium          Modrinth, narrowed to the active instance
ender add sodium cf:jei      add and install
ender drop sodium            remove from the manifest and from disk
ender sync                   make mods/ match the manifest
ender update                 move to the newest compatible builds
```

Fabric is the default loader and the only one ender builds launches for; `--loader vanilla` is the other option. Fabric API is not added for you, because it is not always wanted (Sodium and Lithium declare no dependencies at all) and because anything that does need it names it as a dependency, which ender follows on its own.

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

### Mods you are writing

A path naming a Gradle project is a mod source in its own right, not just a jar:

```
ender add ../minecraft/pandorical
ender sync --build          # rebuild every project-sourced mod, then deploy
```

The version comes from the project's `gradle.properties` at every sync, so a rebuild is picked up with no manifest edit and the previous jar is removed. That is the whole reason to point at the project rather than at a jar: a path with a version in it goes stale the moment you bump it.

The jar itself is found by its version rather than by its name, because the name is not derivable: some projects set `archives_base_name`, some compute it from `mod_id`, some append the author. What holds across all of them is that a jar ends with its version, and that `-sources` and `-testsupport` put their classifier after the version rather than before. `build/libs` keeps every version ever built, so the declared one is picked exactly rather than the newest file.

A project built against a different game version than the instance is refused rather than deployed, and a version that was never built says so instead of silently installing an older jar. `--build` runs the project's own `gradlew` first; without it, nothing is built behind you.

### The file

The manifest is the file, and `ender add` is only a way of editing it. Instance state lives in `instances/<name>/instance.json`:

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

Edit it by hand and run `ender sync`. An entry without a `version` floats; one with a version stays put until `ender update` releases it.

Floating means the newest **release** built for the instance's game version and loader, not simply whatever the source listed first. A stable release wins over a newer alpha, because "latest" almost never means the prerelease that landed this morning. When a version is new enough that nobody has cut a release yet, the best channel actually published is used, so a fresh snapshot still resolves. `--pre` on `add`, `new`, `sync` or `update` drops that preference and takes the newest of anything, and naming a version explicitly always wins outright.

Alongside it, `instance.lock.json` records what was actually installed, including whatever checksum the source published, if it published one. That is what makes removal safe: **sync only deletes files a previous sync put there.** A jar you dropped in by hand is reported and left alone, every time.

### CurseForge without a key

CurseForge works with no API key at all. Their project pages are behind Cloudflare and answer a scraper with 403, but two things are reachable: their own site API lists a project's files, and a public mirror turns a slug into a project id. A file's download url is then derived from its id.

That derivation is exact and unforgiving. The remainder is not padded, so file `8880075` lives under `8880/75` and `8880/075` is refused; the name must be percent-escaped, so a literal `+` is refused where `%2B` is served, and `+` is ordinary in a Fabric jar name. Both rules are pinned by tests against real files.

What you give up without a key is a checksum, because the keyless route publishes none. Those downloads are checked against the length the source declared, which catches a truncated body or an error page but is weaker than a hash: a key restores the hash. Nothing is ever installed with no check at all. There is also no keyless search, because CurseForge publishes none, so `ender search --source curseforge` looks the query up as an exact slug and says so.

Setting `ender config curseforgeKey <key>` with a key from [their console](https://console.curseforge.com/) switches to the official API, which restores search, checksums, and declared dependencies.

### GitHub releases

`ender add gh:owner/repo` takes the newest release that ships a jar; `@tag` pins one. Recent release assets carry a sha256 digest and are verified against it. Older releases predate that field, and those fall back to the declared length like any other source.

Picking the jar takes some care, because a Gradle release usually ships the artifact alongside its sources and javadoc. Those are skipped, then a jar naming the loader wins, then one naming the game version, then the shortest name, which is the plain artifact rather than a variant. When a release ships several real jars, an `asset` pattern in the manifest entry settles it, and the error tells you what the release actually contains.

Unauthenticated GitHub allows sixty requests an hour. `ender config githubToken <token>` raises that, `GITHUB_TOKEN` is read if set, and otherwise the `gh` CLI is asked for its own token.

## Servers

```
ender new world --server --minecraft 26.3
ender server provision       fetch the Fabric server launcher
ender server start           run it in the foreground
ender server offline         set online-mode=false
ender server status          version, port, online-mode, what is installed
```

Mods sync into a server instance exactly as they do into a client one, and every loader that can launch a client can also run a server:

| Loader          | How its server is built                                       |
| --------------- | ------------------------------------------------------------- |
| fabric          | its bootstrap jar, which fetches the rest itself              |
| quilt           | its own installer                                             |
| forge, neoforge | their own installer, started from the argument file it writes |
| vanilla         | Mojang's server jar                                           |

Fabric is the only one that ships a jar you can simply run. Quilt publishes a server profile but no bootstrap to run it with, and Mojang's server download has been a bundler since 1.18 whose own libraries live inside it, so assembling that by hand reproduces work the installers already do correctly. They are asked instead.

## Java

Every Minecraft version names the Java runtime it was built against, and ender takes that seriously rather than reaching for whatever is on the PATH.

```
ender java                   managed runtimes, what is on this machine, what Mojang publishes
ender java install <name>    fetch one ahead of time
```

The order is: an explicit `javaPath`, then a runtime ender already manages, then a local JDK whose major matches exactly, and only then Mojang's own runtime for that version, fetched on the spot. That means a machine that already has the right Java downloads nothing, while a version whose major is missing still gets the runtime it expects instead of a nearby one pressed into service. Launching a 1.16.5 instance on a machine with only Java 25 installs `jre-legacy` and uses it.

Runtimes are identified by asking each binary its version rather than by reading its path, because paths lie, and the answer is cached against the binary's mtime so an in-place upgrade is noticed. `ender config manageJava false` turns the fetching off and keeps discovery.

## Older versions

Since 1.19 the game unpacks its own native libraries out of the classpath, and ender only has to make the directory. Before that, natives ship as jars the launcher is expected to unpack, so ender unpacks them. Both shapes are handled, and there is no version floor.

## Caches

Libraries and assets are shared across instances, under `~/.local/share/ender-launcher`. On the first install, any file another launcher already has is hardlinked rather than downloaded, so adopting a Prism setup costs close to nothing in either bandwidth or disk. Set `ENDER_HOME` to put everything somewhere else.

## Tests

```
bun test
```

## License

ISC.
