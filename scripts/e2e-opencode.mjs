// Scratch end-to-end check: the real OpenCodeBackend against the real opencode
// CLI with a real schema. Not part of `npm test` (it needs the CLI, a signed-in
// provider, and network); run it by hand from the repo root with `node`.
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const z = require("zod");

const dir = mkdtempSync(path.join(tmpdir(), "oc-e2e-"));
const out = path.join(dir, "opencode.mjs");
await build({ entryPoints: ["src/opencode.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
const mod = await import(pathToFileURL(out).href);

const settings = { opencodePath: "", opencodeModel: "deepseek/deepseek-flash" };
const backend = new mod.OpenCodeBackend(() => settings);

console.log("--- probe ---");
const p = await backend.probe();
console.log("  probe:", p.model, "via", p.via);

console.log("--- listModels ---");
const models = await backend.listModels();
console.log("  count:", models.length, "| deepseek/deepseek-flash present:", models.includes("deepseek/deepseek-flash"));

console.log("--- complete (schema-shaped) ---");
const Cards = z.object({
  cards: z.array(z.object({ kind: z.enum(["qa", "cloze"]), front: z.string(), back: z.string(), text: z.string() })),
});
const res = await backend.complete({
  system: "You write spaced-repetition flashcards. Test only what the highlight itself states.",
  user:
    "Write at most 2 cards.\n\n" +
    "<highlight>The general adaptation syndrome unfolds in three stages: alarm, resistance, and exhaustion.</highlight>",
  schema: Cards,
  label: "cards",
  maxTokens: 8000,
});
console.log("  cards returned:", res.cards.length);
for (const c of res.cards) console.log("   ", c.kind, "|", (c.front || c.text).slice(0, 90), "->", c.back.slice(0, 40));

console.log("--- completeText ---");
let stop = null;
const txt = await backend.completeText({
  system: "Answer briefly.",
  user: "Name the three stages of the general adaptation syndrome.",
  maxTokens: 200,
  onStop: (s) => (stop = s),
});
console.log("  text:", JSON.stringify(txt.slice(0, 120)), "| stop:", stop);

console.log("--- abort with nothing in flight ---");
await backend.abort();
console.log("  ok");

console.log("--- a missing model must fail with a named fix, not a crash ---");
// Sessions must not accumulate, and the failure path is the one that used to
// leak: `exec` classified and threw before the cleanup ran, so a failed run
// left the row its own event stream had already named. A failing call is
// therefore the case worth asserting, not a succeeding one.
const sessionCount = () => {
  try {
    const raw = execFileSync(BIN, ["session", "list"], { cwd: mod.scratchDir(), encoding: "utf8", timeout: 30000 });
    return raw.trim().split("\n").filter(Boolean).length;
  } catch {
    return -1;
  }
};
const sessionsBefore = sessionCount();
try {
  await backend.complete({
    system: "x",
    user: "x",
    schema: z.object({ ready: z.boolean() }),
    label: "probe",
    maxTokens: 50,
    model: "nope/nope",
  });
  console.log("  UNEXPECTED: no error");
} catch (e) {
  console.log("  kind:", e.kind, "| message:", e.message.slice(0, 160));
}
await new Promise((r) => setTimeout(r, 5000));
const sessionsAfter = sessionCount();
console.log("  sessions:", sessionsBefore, "->", sessionsAfter, sessionsAfter > sessionsBefore ? "<-- LEAKED" : "(no leak)");
