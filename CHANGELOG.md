# Changes

Each release's notes, newest first. A release is published with its section here as its notes.

## 0.4.0

### Before you upgrade

- **The index's data moved.** ender now reads it from `https://raw.githubusercontent.com/fatlard1993/ender-index/data/`, the index's `data` branch. ender 0.3 and earlier read `.../main/data/`, which the index copies there once a day until **22 December 2026** and then stops updating. An older ender keeps working after that, but from data frozen on that day: no new mods, releases or known-bad jars. `ender upgrade` before then. From 0.4, ender asks the index where its data is served, so a later move needs no upgrade.
- **A jar whose code names where other programs keep logins** (Discord's token store, a browser's saved passwords, a wallet) is held back until you trust it with `--trust`, or from `ender web`. Every other finding stays a warning.
- **A source build's allowance covers the build scripts it was given for.** A later commit whose Gradle wrapper, scripts, properties or build logic changed is held, naming each file and printing the diff, until `ender add <repo> --build` allows it again. An allowance from 0.3 is asked for once more, since 0.3 did not keep which scripts it covered.
- **A jar on the index's known-bad list is refused from any source**: Modrinth, CurseForge, a link or a pack. One listed after you installed it is taken out on the next sync.
- **A server instance leaves out client-only jars**, as each jar's own metadata says, from any source.
- **Accounts taken over from Prism need one sign in through ender's own app.** ender renews a sign in only through its app now, since Prism's tokens answer to Prism's registration; such an account plays until its token ends, then asks for `ender account add`, and `ender account` marks it. `ender account import` asks for that sign in for each of Prism's accounts.
- **`instance.json`, its lock and `config.json` now name a `format`.** Files from 0.3 are read as they are, and an older ender ignores the new field.

### Packs

- Resource packs and shader packs install into their own folders, and new ones are turned on.
- Any entry can be optional, with a description and a default; ender installs it only once a player turns it on (`ender optional`).
- A pack can pin its loader version and name its version, author, memory and servers. The servers are added to the multiplayer list after the player's own.
- A pack's config and other files reach its followers on update. A file the player edited is kept.
- Data packs for every world travel with a pack (`datapacks/`, `global_packs/`), and so do the other folders mods read from the game directory.
- packwiz packs are imported and followed like ender packs, from a repository, a file, or the link to a `pack.toml`, including the jars their index lists.
- `ender export --mrpack` writes an instance as a Modrinth pack. `--pin-loader`, `--servers`, `--version` and `--author` fill in a pack's fields.
- `ender.pack.json` names its `format`, 1. A pack from a newer format is read with a line saying to upgrade.
- A pack can no longer name a jar or Gradle project on the machine that imports it, or a path outside the game directory.

### Scanning

- Scanner 3 names the method each call is made in, reads Forge's SRG names, and warns of an entry point that does work in its static initializer and of an archive two readers would read differently. It also warns of webhooks, the session token, persistence, the clipboard and hidden code, and finds native code, connections and agents by more routes.
- `ender scan` shows a mod author's explanation under the finding it answers, from the index.

### ender web

- Trusts a held-back jar by its hash and runs the stopped job again.
- Shows a source build held for changed build scripts, with the diff, and allows it on a second confirmation.
- Turns a pack's optional entries on and off, makes an instance of a pack made on the index's site, and names your GitHub organizations so the site's Your mods lists their mods.
- Refuses every request another site could send it, each case held by a test.

### The index

- An update asks only for what changed. It reads the index's `changes.json`, the records whose releases changed in the last week, and fetches only those, instead of asking about every installed mod. It no longer downloads the 5 MB listing, and places dependencies from the index's `providers.json`, kept for up to a week, or a day when something it requires cannot be placed. For a 100-mod instance, the day's first update went from about 110 requests and 7 MB to about 5 requests and under 1.5 MB, and later updates that day to a few kilobytes.
- ender reads the index's data wherever its `index.json` says it is served, over https, and remembers that for when the manifest cannot be read, so the data can move to another host without a new ender. An address set with `ender config index` is read as it is.
- ender says once when the index publishes a newer data shape than it reads.

### Fixes

- A Forge dependency entry that names no mod is skipped, as Forge skips it.
- A mod's side is read whatever case its jar writes it in, with Quilt's `dedicated_server` as server.
- A mod spec or pack repository with an empty, `.` or `..` part, or a backslash, is refused.
- A sign-in Minecraft refuses says what Minecraft said, and what to do about it.

### Systems

- The tests run on Linux, macOS and Windows on every push.
- The installer refuses a Mac older than macOS 13, which ender's runtime needs, and Ender.app says so.
