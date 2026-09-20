"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, useApi } from "@/lib/client";
import { Chip, Spinner } from "@/components/ui";

type ProviderId = "anthropic" | "openai-compatible";
type Choice = ProviderId | "auto" | "none";

interface ModelOption { id: string; name: string; kind: string; compatible?: boolean; contextWindow?: number }
interface ModelList { provider: ProviderId; configured: boolean; source: "api" | "cache" | "builtin"; fetchedAt: number | null; models: ModelOption[]; selected: string; error?: { summary: string; hint: string } }
interface ProviderView { label: string; configured: boolean; model: string; defaultModel: string; savedModel: string | null; keyVariable: string; endpoint?: string }
interface SettingsView {
  envFile: string;
  runtime: "docker" | "local";
  provider: Choice;
  savedProvider: Choice | null;
  effective: { available: boolean; provider: string; model: string };
  providers: Record<ProviderId, ProviderView>;
  health?: { ok?: boolean; problem?: { summary: string; hint: string }; model: string; provider: string };
}

const IDS: ProviderId[] = ["anthropic", "openai-compatible"];
const CUSTOM = "__custom__";
const CHOICES: { id: Choice; label: string; help: string }[] = [
  { id: "auto", label: "Automatic", help: "Use Anthropic if its key is set, otherwise OpenAI." },
  { id: "anthropic", label: "Anthropic (Claude)", help: "Always use Claude." },
  { id: "openai-compatible", label: "OpenAI or compatible", help: "Always use OpenAI, or the endpoint in OPENAI_BASE_URL." },
  { id: "none", label: "Off", help: "Deterministic analysis only." },
];

function sourceNote(l: ModelList | undefined): string {
  if (!l) return "";
  if (l.source === "builtin") return `Showing built-in suggestions. ${l.error?.summary ?? ""}`.trim();
  const when = l.fetchedAt ? new Date(l.fetchedAt).toLocaleTimeString() : "";
  const n = `${l.models.length} model${l.models.length === 1 ? "" : "s"}`;
  return l.source === "api" ? `${n} loaded from the provider at ${when}.` : `${n} from the last refresh at ${when}.${l.error ? ` The latest refresh failed: ${l.error.summary}` : ""}`;
}

export function AISettings({ onChanged, onClose }: { onChanged: () => void; onClose: () => void }) {
  const settings = useApi<SettingsView>("/api/ai/settings");
  const initialAnthropic = useApi<ModelList>("/api/ai/models?provider=anthropic");
  const initialOpenAI = useApi<ModelList>("/api/ai/models?provider=openai-compatible");
  const initial: Record<ProviderId, ReturnType<typeof useApi<ModelList>>> = { anthropic: initialAnthropic, "openai-compatible": initialOpenAI };
  // A manual refresh replaces the initially loaded catalogue.
  const [refreshed, setRefreshed] = useState<Partial<Record<ProviderId, ModelList>>>({});
  const [refreshing, setRefreshing] = useState<Partial<Record<ProviderId, boolean>>>({});
  // Edits are kept as drafts on top of the saved settings, so nothing needs copying into state.
  const [draftChoice, setDraftChoice] = useState<Choice | null>(null);
  const [draftModels, setDraftModels] = useState<Partial<Record<ProviderId, string>>>({});
  const [custom, setCustom] = useState<Record<ProviderId, boolean>>({ anthropic: false, "openai-compatible": false });
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; hint?: string } | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const refresh = useCallback(async (id: ProviderId) => {
    setRefreshing((b) => ({ ...b, [id]: true }));
    try {
      const l = await api<ModelList>(`/api/ai/models?provider=${id}&refresh=1`);
      setRefreshed((s) => ({ ...s, [id]: l }));
      setRefreshError(null);
    } catch (e) {
      setRefreshError(e instanceof ApiError ? e.message : "Could not refresh models.");
    } finally {
      setRefreshing((b) => ({ ...b, [id]: false }));
    }
  }, []);

  useEffect(() => { headingRef.current?.focus(); }, []);

  const s = settings.data;
  const restart = s?.runtime === "docker" ? "docker compose up -d" : "brody restart";
  const choice: Choice = draftChoice ?? s?.provider ?? "auto";
  const modelOf = (id: ProviderId): string => draftModels[id] ?? s?.providers[id].model ?? "";

  const persist = async (body: unknown, test: boolean) => {
    setSaving(true);
    setResult(null);
    try {
      const view = await api<SettingsView>(`/api/ai/settings${test ? "?test=1" : ""}`, { method: "PUT", body: JSON.stringify(body) });
      if (!view.effective.available) setResult({ ok: false, text: "Saved, but AI is not available with this selection.", hint: view.provider === "none" ? "AI is turned off." : "Add the provider's API key to .env and restart Brody." });
      else if (view.health?.ok === false) setResult({ ok: false, text: `Saved, but the test failed. ${view.health.problem?.summary ?? ""}`.trim(), hint: view.health.problem?.hint });
      else setResult({ ok: true, text: `Working. Brody will use ${view.effective.model} (${view.effective.provider === "anthropic" ? "Anthropic" : "OpenAI-compatible"}) for new analyses.` });
      setDraftChoice(null);
      setDraftModels({});
      setCustom({ anthropic: false, "openai-compatible": false });
      onChanged();
      settings.reload();
    } catch (e) {
      setResult({ ok: false, text: e instanceof ApiError ? e.message : "Could not save the settings.", hint: e instanceof ApiError ? e.hint : undefined });
    } finally {
      setSaving(false);
    }
  };

  const save = () => persist({ provider: choice, models: { anthropic: modelOf("anthropic").trim() || null, "openai-compatible": modelOf("openai-compatible").trim() || null } }, true);
  const reset = () => persist({ provider: null, models: { anthropic: null, "openai-compatible": null } }, false);

  return (
    <section id="ai-settings" className="card mt-4 p-4" aria-labelledby="ai-settings-h">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="ai-settings-h" ref={headingRef} tabIndex={-1} className="text-base font-semibold outline-none">AI settings</h2>
          <p className="mt-1 max-w-[75ch] text-sm text-muted">Choose the AI provider and model for new analyses. API keys stay in <code>.env</code> and are never shown or stored here. Changes apply immediately, with no restart.</p>
        </div>
        <button className="btn" onClick={onClose}>Close</button>
      </div>

      {s && (
        <div className="mt-3 rounded-sm border px-3 py-2 text-sm" style={{ borderColor: "var(--accent)", background: "var(--accent-soft)" }} data-testid="api-key-note">
          <div className="font-medium">Where to enter your API key</div>
          <ol className="mt-1 list-decimal pl-5 text-[13px]">
            {s.runtime === "docker" ? (
              <li>In the folder that holds <code>docker-compose.yml</code> on your computer, open <code>.env</code> in a text editor (copy <code>.env.example</code> to <code>.env</code> if it does not exist). The container cannot be edited from inside.</li>
            ) : (
              <li>Open <code>{s.envFile}</code> in a text editor (copy <code>.env.example</code> to <code>.env</code> if it does not exist).</li>
            )}
            <li>Add <code>ANTHROPIC_API_KEY=your-key</code> for Claude and/or <code>OPENAI_API_KEY=your-key</code> for OpenAI, on their own lines.</li>
            <li>Run <code>{restart}</code> in a terminal so the key is loaded.</li>
            <li>Return here, choose the provider and model below, then click <strong>Save and test</strong>.</li>
          </ol>
          <p className="mt-1 text-xs text-muted">For security, keys are never typed into this page, never displayed and never sent by the server. Only provider and model choices are saved here.</p>
        </div>
      )}
      {settings.error && <div role="alert" className="mt-3 text-sm" style={{ color: "var(--crit)" }}>{settings.error.message}</div>}
      {refreshError && <div role="alert" className="mt-3 text-sm" style={{ color: "var(--crit)" }}>{refreshError}</div>}
      {!s && !settings.error && <div role="status" className="mt-3 flex items-center gap-2 text-sm text-muted"><Spinner className="text-accent" />Loading settings…</div>}

      {s && (
        <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Provider</legend>
            <div className="grid gap-2">
              {CHOICES.map((c) => {
                const configured = c.id === "anthropic" || c.id === "openai-compatible" ? s.providers[c.id].configured : null;
                return (
                  <label key={c.id} className="flex cursor-pointer items-start gap-2 text-sm">
                    <input type="radio" name="ai-provider" className="mt-1" checked={choice === c.id} onChange={() => setDraftChoice(c.id)} />
                    <span>
                      <span className="font-medium">{c.label}</span> {configured !== null && <Chip tone={configured ? "ok" : "warn"}>{configured ? "ready" : "no key"}</Chip>}
                      <span className="block text-xs text-muted">{c.help}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div className="grid gap-5 md:grid-cols-2">
            {IDS.map((id) => {
              const p = s.providers[id];
              const list = refreshed[id] ?? initial[id].data ?? undefined;
              const loading = !!refreshing[id] || (initial[id].loading && !list);
              const options = list?.models ?? [];
              const known = options.some((m) => m.id === modelOf(id));
              // Until the catalogue arrives, show the current model rather than flashing "Other".
              const selectValue = !list ? modelOf(id) : custom[id] || !known ? CUSTOM : modelOf(id);
              const inputId = `model-${id}`;
              return (
                <div key={id}>
                  <div className="flex items-center justify-between gap-2">
                    <label htmlFor={inputId} className="text-sm font-medium">{p.label} model</label>
                    <button className="btn" onClick={() => void refresh(id)} disabled={loading} aria-busy={loading} aria-label={`Refresh ${p.label} models`}>{refreshing[id] ? "Refreshing…" : "Refresh models"}</button>
                  </div>
                  <select id={inputId} className="input mt-1" value={selectValue} disabled={!list && loading} onChange={(e) => { if (e.target.value === CUSTOM) setCustom((c) => ({ ...c, [id]: true })); else { setCustom((c) => ({ ...c, [id]: false })); setDraftModels((m) => ({ ...m, [id]: e.target.value })); } }}>
                    {!list && <option value={modelOf(id)}>{modelOf(id)}</option>}
                    {options.map((m) => <option key={m.id} value={m.id} disabled={m.compatible === false}>{m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id}{m.compatible === false ? " - no structured output" : ""}</option>)}
                    <option value={CUSTOM}>Other model ID…</option>
                  </select>
                  {selectValue === CUSTOM && (
                    <div className="mt-2">
                      <label htmlFor={`${inputId}-custom`} className="text-xs text-muted">Model ID</label>
                      <input id={`${inputId}-custom`} className="input mt-0.5" value={modelOf(id)} onChange={(e) => setDraftModels((m) => ({ ...m, [id]: e.target.value }))} placeholder={p.defaultModel} spellCheck={false} autoComplete="off" />
                    </div>
                  )}
                  <p className="mt-1 text-xs text-muted" aria-live="polite">
                    {loading ? "Loading models…" : sourceNote(list)}
                  </p>
                  {list?.error && list.source === "builtin" && <p className="text-xs text-muted">{list.error.hint}</p>}
                  {list?.error && list.source === "cache" && <p className="text-xs text-muted">{list.error.hint}</p>}
                  {!p.configured && <p className="mt-1 text-xs" style={{ color: "var(--med)" }}>No key yet: add <code>{p.keyVariable}</code> to <code>.env</code>, then run <code>{restart}</code>.</p>}
                  {id === "openai-compatible" && p.endpoint && <p className="text-xs text-muted">Endpoint: {p.endpoint}</p>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {s && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button className="btn btn-primary" onClick={save} aria-busy={saving} disabled={saving || !modelOf(choice === "openai-compatible" ? "openai-compatible" : "anthropic").trim()}>{saving ? "Saving and testing…" : "Save and test"}</button>
          <button className="btn" onClick={reset} disabled={saving}>Reset to defaults</button>
          <span className="text-xs text-muted">Saving makes one small test request to the selected provider.</span>
        </div>
      )}
      {result && (
        <div role={result.ok ? "status" : "alert"} className="card mt-3 px-3 py-2 text-sm" style={{ borderColor: result.ok ? "var(--ok)" : "var(--crit)" }}>
          {result.text} {result.hint}
        </div>
      )}
    </section>
  );
}
