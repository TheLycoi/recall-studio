/**
 * The topic folder's default, kept apart from settings.ts so it can be tested
 * without Obsidian (test/settingsDefaults.test.mjs bundles it standalone).
 *
 * Ask, Lint and the digest read and write the topic folder. The ingest engine
 * writes under the parent of the concepts folder, `wiki/` by default
 * (upstreamWikiFolder in src/upstream/host.ts), so the topic folder defaults
 * to the same place: a fresh install sees what ingest writes.
 */
export const DEFAULT_TOPIC_FOLDER = "wiki";

/** The folder installs used before the default moved to `wiki`. */
export const LEGACY_TOPIC_FOLDER = "classes";

/**
 * The topic folder an install should use on load. Pure.
 *
 * A saved value wins. Saved settings with no topic folder come from a version
 * that predates the setting, when the folder was `classes`; if the vault has
 * a `classes` folder that install keeps it, so nobody loses sight of their
 * pages. Nothing saved at all is a fresh install, which gets `wiki` even when
 * the vault happens to have a `classes` folder of its own.
 */
export function resolveTopicFolderDefault(saved: { topicFolder?: string } | null, hasClassesFolder: boolean): string {
  if (saved?.topicFolder) return saved.topicFolder;
  if (saved && hasClassesFolder) return LEGACY_TOPIC_FOLDER;
  return DEFAULT_TOPIC_FOLDER;
}
