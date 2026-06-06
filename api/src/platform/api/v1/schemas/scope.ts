import { z } from 'zod';

/** A registered OAuth scope (from the ScopeRegistry). */
export const ScopeSchema = z.object({
  scope: z.string(),
  description: z.string(),
  exercised: z.boolean(),
});

export const ScopeListSchema = z.object({
  data: z.array(ScopeSchema),
});
