/** Turn provider failures into a short summary plus an actionable hint. Never includes credentials. */
export function explainAIError(message: string): { summary: string; hint: string } {
  const m = message.toLowerCase();
  if (m.includes("econnrefused") || m.includes("enotfound") || m.includes("fetch failed") || m.includes("connection") || m.includes("timed out") || m.includes("timeout")) return { summary: "The AI provider could not be reached.", hint: "Check network access from the server, and OPENAI_BASE_URL if you use a compatible endpoint." };
  if (m.includes("workspace")) return { summary: "The API key is not scoped to a workspace.", hint: "Set ANTHROPIC_WORKSPACE_ID to the workspace that should be billed, or create a workspace-scoped API key in the Anthropic Console." };
  if (m.includes("401") || m.includes("authentication") || m.includes("invalid x-api-key") || m.includes("invalid api key")) return { summary: "The AI provider rejected the API key.", hint: "Check ANTHROPIC_API_KEY (or OPENAI_API_KEY) for typos and that it has not been revoked." };
  if (m.includes("403") || m.includes("permission")) return { summary: "The API key does not have permission for this model or request.", hint: "Use a key with access to the selected model, or choose a model your organisation can use in AI settings." };
  if (m.includes("credit") || m.includes("billing") || m.includes("balance")) return { summary: "The account has no usable credit.", hint: "Add credit or fix billing in the provider console, then re-run the analysis." };
  if (m.includes("404") || m.includes("not_found") || m.includes("model:")) return { summary: "The configured model was not found.", hint: "Choose an available model in AI settings (use Refresh models to load the list your account can use)." };
  if (m.includes("429") || m.includes("rate limit") || m.includes("rate_limit")) return { summary: "The provider rate limit was hit.", hint: "Lower AI_CONCURRENCY or retry later." };
  if (m.includes("529") || m.includes("overloaded") || m.includes("503") || m.includes("502") || m.includes("500")) return { summary: "The AI provider is temporarily unavailable.", hint: "Retry the analysis in a few minutes." };
  if (m.includes("refusal") || m.includes("declined")) return { summary: "The model declined some requests.", hint: "Affected passes are skipped; deterministic findings are unaffected." };
  return { summary: "AI requests failed.", hint: "See the analysis log for the provider's message." };
}
