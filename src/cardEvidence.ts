import type { Card, GenerationPreparation, Highlight } from "./model";

export interface CardEvidence {
  state: "resolved" | "legacy" | "missing";
  plan?: GenerationPreparation["plan"][number];
  facts: GenerationPreparation["facts"];
}

/** Fact and plan IDs are local to a batch, including retained historical batches. */
export function resolveCardEvidence(highlight: Highlight, card: Card): CardEvidence {
  const generation = card.generation;
  if (!generation) return { state: "legacy", facts: [] };
  const batches = [highlight.generation, ...(highlight.generationHistory ?? [])]
    .filter(batch => batch?.id === generation.batchId);
  if (batches.length !== 1 || !batches[0]?.preparation) return { state: "missing", facts: [] };
  const preparation = batches[0].preparation;
  const plans = preparation.plan.filter(plan => plan.id === generation.planId);
  if (plans.length !== 1 || !generation.factIds.length) return { state: "missing", facts: [] };
  const plan = plans[0];
  const facts: GenerationPreparation["facts"] = [];
  for (const id of new Set(generation.factIds)) {
    const matches = preparation.facts.filter(fact => fact.id === id);
    if (matches.length !== 1 || !plan.factIds.includes(id)) return { state: "missing", facts: [] };
    facts.push(matches[0]);
  }
  return { state: "resolved", plan, facts };
}
