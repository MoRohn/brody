/** Request contracts shared by the HTTP API, the agent tool and the MCP server. */
import { z } from "zod";
import { sourceSchema } from "./compile";

export const audienceSchema = z.enum(["beginner", "intermediate", "expert"]);
export const durationSchema = z.enum(["quick", "standard", "deep"]);

export const createSchema = z.object({
  projectId: z.string().min(4).max(64),
  source: sourceSchema,
  audience: audienceSchema.optional(),
  intent: z.string().max(500).optional(),
  reuse: z.boolean().optional(),
});

export const videoSchema = z.object({
  duration: durationSchema.optional(),
  audience: audienceSchema.optional(),
  style: z.enum(["brody", "brody-light", "calm"]).optional(),
  renderer: z.enum(["auto", "manim", "html"]).optional(),
  execution: z.enum(["local", "cloud", "hybrid"]).optional(),
  ttsProvider: z.string().max(40).regex(/^[a-z0-9-]+$/).optional(),
  voice: z.string().max(120).regex(/^[\w .:()/-]*$/).optional(),
  allowExternal: z.boolean().optional(),
  motion: z.enum(["full", "reduced"]).optional(),
});

export const refineSchema = z.object({ request: z.string().trim().min(3).max(600) });
export const narrationSchema = z.object({ narration: z.record(z.string().max(40), z.string().max(4000)) });
export const regenerateSchema = z.object({ sectionId: z.string().max(40).optional(), sections: z.array(z.string().max(40)).max(12).optional(), instruction: z.string().max(600).optional() });
export const patchSchema = z.object({ audience: audienceSchema });
