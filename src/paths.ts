/**
 * Where things live by default.
 *
 * The wiki folder belongs to the wiki plugin, and Review Inbox only reads it.
 * So the files Review Inbox writes to the vault, the card rules note, the
 * inbox, the rule suggestions and the Anki text exports, default to a folder of
 * Review Inbox's own.
 *
 * Pure: no `obsidian` import (test/paths.test.mjs bundles it standalone).
 */
export const DEFAULT_WIKI_FOLDER = "wiki";
export const DEFAULT_RULES_FOLDER = "Review Inbox";
export const DEFAULT_EXPORT_FOLDER = "Review Inbox/exports";

import { isUnderFolder } from "./util";

export { isUnderFolder };

/** May capture write a mark into this file? Never into a page under the wiki folder, whatever the mark mode. */
export function mayMark(path: string, wikiFolder: string): boolean {
  return !isUnderFolder(path, wikiFolder);
}
