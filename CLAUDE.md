# ender-launcher

A Minecraft instance, mod and server manager. Bun, ESM, tabs. `bun test` before you push;
`bun run lint` has to be clean of errors.

## Guards, strongest first: type, test, name, comment

Only the last one is unchecked, so the urge to explain is the signal to reach for one of
the first three. Rename it, extract it, or pin it with a test. The commit owns the story of
how the code got here.

A comment earns its place when it records a constraint from outside this repository that no
guard can hold - Mojang gating a manifest feature behind a rule, Homebrew refusing an
untrusted tap, Steam keying a shortcut off its target path. Those are present-tense facts
about the world. A narrated history of what the code used to do is not one.

The worked example is in this repo. `src/commands/account.js` once carried four lines
explaining why `--names` exists; `test/auth.test.js` now says the same thing as three
assertions that fail when it regresses, and the comment is gone. Same move in
`src/cli/help.js`: a comment quoted the broken output string `--no-assets  Include game
assets` as prose, and `test/cli.test.js` asserts no `--no-` row prints its positive
description.

## Output is an interface

`ender ls --names` and `ender account --names` exist because scripts were matching the
human listings by shape, and a change to a column would have broken them silently. When a
caller needs to branch on what this tool knows, give it a line it can test, not prose it
has to parse.

## Failure

Say what failed and to whom. A step that could not do its job does not return quietly: an
exit status nothing reads and a message nothing prints are the same defect. If a wait is
longer than a second or two, say so before it starts.
