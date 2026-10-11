import { z } from "zod";

/**
 * Reading JSON out of a model's answer, and describing a schema to a model
 * that has no native structured-output support.
 *
 * Pure: no `obsidian`, no `child_process`. test/deepseek.test.mjs bundles it
 * standalone. Both the Codex backend and the DeepSeek backend use it, so the
 * two agree on what a well-formed answer looks like.
 */

/** Strip ``` fences and any prose around the outermost JSON value. */
export function extractJson(text: string): string {
  let t = text.trim();
  const fence = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```\s*$/.exec(t);
  if (fence) t = fence[1].trim();
  if (t.startsWith("{") || t.startsWith("[")) return t;
  const open = t.search(/[[{]/);
  const close = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (open >= 0 && close > open) return t.slice(open, close + 1);
  return t;
}

/**
 * JSON Schema for a zod schema, with the `$schema` keyword removed: OpenAI's
 * strict `--output-schema` mode rejects it, and a model reading the schema in
 * a prompt gains nothing from it.
 */
export function schemaJson(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema) as Record<string, unknown>;
  delete js.$schema;
  return js;
}
