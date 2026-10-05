/**
 * Which files the quiz may ask about.
 *
 * The wiki folder belongs to the wiki plugin. Its pages are knowledge. Its
 * own files are not: the schema folder is its house rules, and index, log and
 * the welcome note are navigation it writes for itself.
 *
 * Pure: no `obsidian` import (test/quizPages.test.mjs bundles it standalone).
 */
export function isQuizPage(path: string, wikiFolder: string): boolean {
  const folder = wikiFolder.replace(/^\/+|\/+$/g, "");
  if (!folder || !/\.md$/i.test(path)) return false;
  if (!path.startsWith(`${folder}/`)) return false;
  const rest = path.slice(folder.length + 1);
  if (rest.startsWith("schema/")) return false;
  const base = (rest.split("/").pop() ?? "").replace(/\.md$/i, "").toLowerCase();
  if (base === "index" || base === "log") return false;
  if (base.startsWith("welcome to ")) return false;
  return true;
}
