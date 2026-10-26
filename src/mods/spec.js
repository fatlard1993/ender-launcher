/** `sodium`, `modrinth:sodium@0.5.8`, `cf:jei`, `./build/libs/mod.jar`, or a url. */
const PREFIXES = { github: 'gh:', codeberg: 'cb:', gitlab: 'gl:', modrinth: 'mr:', curseforge: 'cf:' };

/** How a mod found by search is written so that parseModSpec reads it back to the source it came from. */
export const specFor = (source, id) => `${PREFIXES[source]}${id}`;
