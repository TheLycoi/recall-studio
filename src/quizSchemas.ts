import { z } from "zod";
/** Separate bounded schemas do not alter the legacy free-response contract. */
export const QuizChoiceOut = z.object({
  question: z.string().min(1).max(600),
  point: z.number().int(),
  choices: z.array(z.object({ id: z.string().length(1).regex(/^[A-E]$/), text: z.string().min(1).max(2000) })).min(2).max(5),
  correctId: z.string(),
});
export type QuizChoiceDraft = z.infer<typeof QuizChoiceOut>;
export const QuizQuestionAuditOut = z.object({ supported: z.boolean() });
export const QuizGradeAuditOut = z.object({ points: z.array(z.object({ n: z.number().int(), agrees: z.boolean() })) });
export const QuizChoiceAuditOut = z.object({ choices: z.array(z.object({ id: z.string(), supported: z.boolean() })) });
export type QuizChoiceAudit = z.infer<typeof QuizChoiceAuditOut>;
