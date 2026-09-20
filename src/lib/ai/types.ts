import type { z } from "zod";

export interface AnalysisRequest<T> {
  /** Short stable task name used for logging and cache keys. */
  task: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  /** Output token ceiling; defaults are chosen per provider. */
  maxTokens?: number;
}

export interface AnalysisUsage {
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

export interface AnalysisResult<T> {
  data: T;
  model: string;
  provider: string;
  usage: AnalysisUsage;
}

/**
 * Provider abstraction. Repository intelligence code depends only on this
 * interface, never on a specific vendor SDK.
 */
export interface AIProvider {
  readonly name: string;
  readonly model: string;
  analyze<T>(request: AnalysisRequest<T>): Promise<AnalysisResult<T>>;
  /** Optional embedding support for semantic retrieval. */
  embed?(texts: string[]): Promise<number[][]>;
  /** Cheap credential and model check: succeeds if the endpoint accepts the key and knows the model. */
  ping?(): Promise<void>;
  /** Models the account can use, as reported by the provider. */
  listModels?(): Promise<ModelOption[]>;
}

export interface ModelOption {
  id: string;
  /** Human-readable name when the provider supplies one. */
  name: string;
  kind: "chat" | "embedding";
  /** Unix seconds, when known. */
  created?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** False when the provider reports the model cannot produce schema-constrained output, which Brody requires. */
  compatible?: boolean;
}

export class AIUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AIUnavailableError";
  }
}

export class AIResponseError extends Error {
  constructor(message: string, public readonly detail?: string) {
    super(message);
    this.name = "AIResponseError";
  }
}
