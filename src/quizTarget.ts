/** Exact metadata resolution comes before topic suggestions; suggestions never authorize a read. */
export interface QuizNote {
  path: string;
  name: string;
  aliases: string[];
  tags: string[];
}
export type QuizTarget =
  | { kind: "resolved"; paths: string[]; label: string }
  | { kind: "choices"; choices: QuizNote[] }
  | { kind: "missing" };
const fold = (s: string) => s.trim().toLocaleLowerCase();
export function resolveQuizTarget(query: string, notes: QuizNote[], active: string | null): QuizTarget {
  const q = query.trim().replace(/^\[\[([\s\S]*)\]\]$/, "$1");
  if (!q) {
    const note = notes.find(n => n.path === active);
    return note ? { kind: "resolved", paths: [note.path], label: note.name } : { kind: "missing" };
  }
  if (q.startsWith("#")) {
    const tag = fold(q);
    const matches = notes.filter(n => n.tags.some(t => fold(t) === tag || fold(t).startsWith(`${tag}/`)));
    return matches.length ? { kind: "resolved", paths: matches.map(n => n.path), label: q } : { kind: "missing" };
  }
  const key = fold(q).replace(/\.md$/, "");
  const paths = notes.filter(n => fold(n.path).replace(/\.md$/, "") === key);
  if (paths.length === 1) return { kind: "resolved", paths: [paths[0].path], label: paths[0].name };
  const matches = notes.filter(n => [n.name, ...n.aliases].some(s => fold(s) === key));
  if (matches.length === 1) return { kind: "resolved", paths: [matches[0].path], label: matches[0].name };
  if (matches.length > 1) return { kind: "choices", choices: matches };
  if (/[/\\]|\.md$/i.test(q)) return { kind: "missing" };
  const suggestions = notes.filter(n => [n.path, ...n.aliases, ...n.tags].some(s => fold(s).includes(key)));
  return suggestions.length ? { kind: "choices", choices: suggestions.slice(0, 20) } : { kind: "missing" };
}
