"use client";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { DownloadMenu } from "@/components/download";
import { Chip, ErrorBox, Loading, SourceLink } from "@/components/ui";
import { api, ApiError, useApi } from "@/lib/client";
import type { Answer } from "@/lib/ask";

interface Turn { id: string; question: string; answer?: Answer; error?: ApiError; pending?: boolean }

const SUGGESTIONS = [
  "How does authentication work?",
  "Where is the ranking algorithm defined?",
  "What writes to the users table?",
  "What happens after POST /checkout?",
  "Which components depend on UserService?",
  "Where could this application lose data?",
];

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
  const history = useApi<{ history: { id: string; question: string; answer: Answer }[] }>(`/api/projects/${id}/ask`);
  const status = useApi<{ ai: { available: boolean; model: string } }>("/api/status");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (history.data && turns.length === 0) setTurns(history.data.history.map((h) => ({ id: h.id, question: h.question, answer: h.answer }))); }, [history.data, turns.length]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [turns.length]);

  const ask = async (question: string) => {
    const text = question.trim();
    if (text.length < 3) return;
    const tid = `t${Date.now()}`;
    setTurns((t) => [...t, { id: tid, question: text, pending: true }]);
    setQ("");
    try {
      const r = await api<{ answer: Answer }>(`/api/projects/${id}/ask`, { method: "POST", body: JSON.stringify({ question: text }) });
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
          <p className="text-muted">Answers come only from the indexed code, and every claim cites the lines it rests on. {status.data && !status.data.ai.available ? "AI is not configured, so questions about symbols, routes, tables and dependencies are answered exactly from the code graph and other questions return the most relevant locations." : `Open-ended questions are answered by ${status.data?.ai.model ?? "the configured model"} from retrieved code excerpts.`}</p>
          {history.loading && !history.data && <Loading />}
          {history.error && <ErrorBox error={history.error} onRetry={history.reload} />}
          {turns.length === 0 && !history.loading && (
            <div className="mt-4"><div className="h-label mb-1">Try asking</div><div className="flex flex-wrap gap-2">{SUGGESTIONS.map((s) => <button key={s} className="btn" onClick={() => ask(s)}>{s}</button>)}</div></div>
          )}
          <div className="mt-4 space-y-5">
            {turns.map((t) => (
              <div key={t.id}>
                <div className="mb-1 font-semibold">{t.question}</div>
                {t.pending && <Loading label="Searching the code and composing an answer" />}
                {t.error && <ErrorBox error={t.error} />}
                {t.answer && (
                  <div className="card">
                    <div className="p-3">
                      <div className="mb-2 flex flex-wrap gap-1.5">
                        <Chip tone={t.answer.mode === "graph" ? "ok" : t.answer.mode === "ai" ? "info" : "neutral"} title={t.answer.mode === "graph" ? "Computed exactly from the symbol graph" : t.answer.mode === "ai" ? "Written by an AI model from retrieved code" : "Ranked locations; no synthesized answer"}>{t.answer.mode === "graph" ? "From code graph" : t.answer.mode === "ai" ? "AI answer" : "Retrieval only"}</Chip>
                        <Chip tone={t.answer.confidence === "high" ? "ok" : t.answer.confidence === "medium" ? "warn" : "neutral"}>confidence: {t.answer.confidence}</Chip>
                        {t.answer.insufficientEvidence && <Chip tone="warn">insufficient evidence</Chip>}
                      </div>
                      <div className="whitespace-pre-wrap">{t.answer.answer}</div>
                      <button className="btn mt-2 py-0 text-xs" onClick={() => navigator.clipboard?.writeText(`### ${t.question}\n\n${t.answer!.answer}\n\n${t.answer!.citations.map((c) => `- \`${c.path}:${c.startLine}-${c.endLine}\``).join("\n")}`)}>Copy as Markdown</button>
                      {t.answer.notes.length > 0 && <div className="mt-2 text-xs text-muted">{t.answer.notes.join(" ")}</div>}
                    </div>
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
        <div className="mx-auto flex max-w-[860px] gap-2">
          <input className="input !rounded-full !px-4 !py-2" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask how something works, where it is defined, or what depends on it…" aria-label="Question about the repository" maxLength={1000} />
          <button className="btn btn-primary btn-cta" type="submit" disabled={q.trim().length < 3}>Ask<span className="disc" aria-hidden>→</span></button>
        </div>
      </form>
    </div>
  );
}
