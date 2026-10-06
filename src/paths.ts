/**
 * Where things live by default.
 *
 * The wiki folder belongs to the wiki plugin, and Recall only reads it. So
 * the three kinds of file Recall writes to the vault, the card rules note,
 * the inbox and rule suggestions, and the Anki text exports, default to a
 * folder of Recall's own.
 *
 * Pure: no `obsidian` import (test/paths.test.mjs bundles it standalone).
 */
export const DEFAULT_WIKI_FOLDER = "wiki";
export const DEFAULT_RULES_FOLDER = "Recall";
export const DEFAULT_EXPORT_FOLDER = "Recall/exports";

export { isUnderFolder } from "./util";
