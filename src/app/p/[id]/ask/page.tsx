"use client";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { DownloadMenu } from "@/components/download";
import { ExplainResult } from "@/components/explainer/explain-menu";
import { useProject } from "@/components/project";
import { Chip, ErrorBox, Loading, SourceLink } from "@/components/ui";
import { api, ApiError, useApi } from "@/lib/client";
import type { Answer } from "@/lib/ask";

interface Turn { id: string; question: string; answer?: Answer; error?: ApiError; pending?: boolean }

/** Shown until the repository's own suggestions load; the server replaces these with questions about its real areas, routes and tables. */
const fallbackSuggestions = (name: string) => [
  `ELI5: how does ${name} work?`,
  `What does ${name} do, and who is it for?`,
  "How does authentication work?",
  "What are the biggest risks, and what should we fix first?",
  "Where should a new developer start reading?",
  "Where could this application lose data?",
];

const MODE: Record<Answer["mode"], { label: string; title: string; tone: "ok" | "info" | "neutral" }> = {
  graph: { label: "From code graph", title: "Computed exactly from the symbol graph", tone: "ok" },
  ai: { label: "AI answer", title: "Written by an AI model from Brody's analysis and the retrieved code", tone: "info" },
  analysis: { label: "From Brody's analysis", title: "Brody's overview of the repository, assembled without an AI model", tone: "ok" },
  retrieval: { label: "Retrieval only", title: "Ranked locations; no synthesized answer", tone: "neutral" },
};

function Cite({ projectId, c }: { projectId: string; c: Answer["citations"][number] }) {
  return (
    <details className="border-b border-line last:border-0">
      <summary className="cursor-pointer px-2 py-1 text-[12px]"><SourceLink projectId={projectId} cite={`${c.path}:${c.startLine}${c.endLine !== c.startLine ? `-${c.endLine}` : ""}`} />{c.note && <span className="ml-2 text-muted">{c.note}</span>}</summary>
      {c.snippet && <pre tabIndex={0} className="!m-1 !mt-0 max-h-48 text-[11.5px]">{c.snippet.split("\n").map((l, i) => `${c.startLine + i}: ${l}`).join("\n")}</pre>}
    </details>
  );
}

export default function AskPage() {
  const { id } = useParams<{ id: string }>();
  const { project } = useProject();
  const history = useApi<{ history: { id: string; question: string; answer: Answer }[]; suggestions?: string[] }>(`/api/projects/${id}/ask`);
  const status = useApi<{ ai: { available: boolean; model: string } }>("/api/status");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (history.data && turns.length === 0) setTurns(history.data.history.map((h) => ({ id: h.id, question: h.question, answer: h.answer }))); }, [history.data, turns.length]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [turns.length]);

  const suggestions = history.data?.suggestions?.length ? history.data.suggestions : fallbackSuggestions(project.name.split("/").pop() || "this repository");
  const busy = turns.some((t) => t.pending);

  const ask = async (question: string) => {
    const text = question.trim();
    if (text.length < 3) return;
    const tid = `t${Date.now()}`;
    // The last few answers travel as context, so "explain that more simply" knows what "that" is.
    const context = turns.map((t) => t.answer?.id ?? (t.id.startsWith("q_") ? t.id : null)).filter((x): x is string => !!x).slice(-3);
    setTurns((t) => [...t, { id: tid, question: text, pending: true }]);
    setQ("");
    try {
      const r = await api<{ answer: Answer }>(`/api/projects/${id}/ask`, { method: "POST", body: JSON.stringify({ question: text, context }) });
      setTurns((t) => t.map((x) => (x.id === tid ? { ...x, pending: false, answer: r.answer } : x)));
    } catch (e) {
      setTurns((t) => t.map((x) => (x.id === tid ? { ...x, pending: false, error: e as ApiError } : x)));
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-[860px] p-5">
          <div className="flex items-center justify-between"><h1 className="font-serif text-2xl font-bold">Ask the repository</h1><DownloadMenu projectId={id} scope="ask" label="Download Q&A" /></div>
          <p className="text-muted">Ask anything, at any level: how it works, what it is for, why it is built this way, what a function does, what to fix first. Answers draw on Brody&apos;s analysis and the indexed code, and cite the lines they rest on. {status.data && !status.data.ai.available ? "AI is not configured, so questions about symbols, routes, tables and dependencies are answered exactly from the code graph, broad questions get Brody's overview, and other questions return the most relevant locations." : `Open-ended questions are answered by ${status.data?.ai.model ?? "the configured model"}; follow-ups such as “explain that more simply” build on the previous answer.`}</p>
          {history.loading && !history.data && <Loading />}
          {history.error && <ErrorBox error={history.error} onRetry={history.reload} />}
          {turns.length === 0 && !history.loading && (
            <div className="mt-4"><div className="h-label mb-1">Try asking</div><div className="flex flex-wrap gap-2">{suggestions.map((s) => <button key={s} className="btn" onClick={() => ask(s)}>{s}</button>)}</div></div>
          )}
          <div className="mt-4 space-y-5">
            {turns.map((t) => (
              <div key={t.id}>
                <div className="mb-1 font-semibold">{t.question}</div>
                {t.answer?.standaloneQuestion && <div className="mb-1 text-xs text-muted">Answered as: {t.answer.standaloneQuestion}</div>}
                {t.pending && <Loading label="Searching the code and composing an answer" />}
                {t.error && <ErrorBox error={t.error} />}
                {t.answer && (
                  <div className="card">
                    <div className="p-3">
                      <div className="mb-2 flex flex-wrap gap-1.5">
                        <Chip tone={(MODE[t.answer.mode] ?? MODE.retrieval).tone} title={(MODE[t.answer.mode] ?? MODE.retrieval).title}>{(MODE[t.answer.mode] ?? MODE.retrieval).label}</Chip>
                        <Chip tone={t.answer.confidence === "high" ? "ok" : t.answer.confidence === "medium" ? "warn" : "neutral"}>confidence: {t.answer.confidence}</Chip>
                        {t.answer.insufficientEvidence && <Chip tone="warn">insufficient evidence</Chip>}
                      </div>
                      <div className="whitespace-pre-wrap">{t.answer.answer}</div>
                      <button className="btn mt-2 py-0 text-xs" onClick={() => navigator.clipboard?.writeText(`### ${t.question}\n\n${t.answer!.answer}\n\n${t.answer!.citations.map((c) => `- \`${c.path}:${c.startLine}-${c.endLine}\``).join("\n")}`)}>Copy as Markdown</button>
                      {t.answer.notes.length > 0 && <div className="mt-2 text-xs text-muted">{t.answer.notes.join(" ")}</div>}
                    </div>
                    {(t.answer.id ?? (t.id.startsWith("q_") ? t.id : null)) && !t.answer.insufficientEvidence && (
                      <div className="border-t border-line px-3 py-2"><ExplainResult projectId={id} source={{ kind: "question", id: (t.answer.id ?? t.id) as string }} /></div>
                    )}
                    {t.answer.citations.length > 0 && <div className="border-t border-line"><div className="h-label bg-panel2 px-2 py-1">Evidence ({t.answer.citations.length})</div>{t.answer.citations.map((c, i) => <Cite key={i} projectId={id} c={c} />)}</div>}
                  </div>
                )}
              </div>
            ))}
            <div ref={endRef} />
          </div>
        </div>
      </div>
      <form className="flex-none border-t border-line bg-panel p-3" onSubmit={(e) => { e.preventDefault(); ask(q); }}>
        {turns.length > 0 && (
          <div className="mx-auto mb-2 flex max-w-[860px] gap-1.5 overflow-x-auto pb-0.5 pr-6 [mask-image:linear-gradient(to_right,black_calc(100%-2.5rem),transparent)]" aria-label="Suggested questions">
            {suggestions.slice(0, 4).map((s) => <button key={s} type="button" className="btn flex-none py-0.5 text-xs" disabled={busy} onClick={() => ask(s)}>{s}</button>)}
          </div>
        )}
        <div className="mx-auto flex max-w-[860px] gap-2">
          <input className="input !rounded-full !px-4 !py-2" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask anything: how it works, what it's for, what a function does, what to fix first…" aria-label="Question about the repository" maxLength={1000} />
          <button className="btn btn-primary btn-cta" type="submit" disabled={q.trim().length < 3}>Ask<span className="disc" aria-hidden>→</span></button>
        </div>
      </form>
    </div>
  );
}
