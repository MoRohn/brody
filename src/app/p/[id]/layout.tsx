"use client";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { DownloadMenu } from "@/components/download";
import { AnalysisProgress, ProjectCtx, SearchBox, StatusChip, type ProjectSummary } from "@/components/project";
import { Brand } from "@/components/Brand";
import { Icon, type IconName } from "@/components/Icon";
import { ThemeControl } from "@/components/ThemeControl";
import { Chip, ErrorBox, Loading } from "@/components/ui";
import { api, useApi } from "@/lib/client";

const NAV: { slug: string; label: string; icon: IconName }[] = [
  { slug: "", label: "Overview", icon: "overview" },
  { slug: "review", label: "Code Review", icon: "review" },
  { slug: "explain", label: "System Explanation", icon: "explain" },
  { slug: "architecture", label: "Architecture", icon: "architecture" },
  { slug: "map", label: "Code Map", icon: "map" },
  { slug: "files", label: "Files", icon: "files" },
  { slug: "ask", label: "Ask Repository", icon: "ask" },
  { slug: "deck", label: "Executive Deck", icon: "deck" },
  { slug: "reports", label: "Reports", icon: "reports" },
];

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [pollKey, setPollKey] = useState(0);
  const { data, error } = useApi<{ project: ProjectSummary }>(`/api/projects/${id}?k=${pollKey}`, {
    pollMs: 1500,
    stop: (d) => d.project.status === "ready" || d.project.status === "failed" || (d.project.status === "created" && !d.project.job) || d.project.job?.status === "cancelled",
  });
  const project = data?.project;
  const reload = useCallback(() => setPollKey((k) => k + 1), []);
  const overview = useApi<{ review?: { total: number; bySeverity: Record<string, number> } }>(project?.status === "ready" ? `/api/projects/${id}/overview` : null);
  const ctx = useMemo(() => (project ? { project, reload } : null), [project, reload]);

  if (error && !project) return <div className="mx-auto max-w-[640px] p-6"><ErrorBox error={error} /><Link className="btn m-4" href="/">Back to projects</Link></div>;
  if (!project || !ctx) return <Loading label="Opening project" />;
  const base = `/p/${id}`;
  const ready = project.status === "ready";
  const crit = (overview.data?.review?.bySeverity?.Critical ?? 0) + (overview.data?.review?.bySeverity?.High ?? 0);

  const reanalyze = async () => {
    setBusy(true);
    try { const r = await api<{ project: { id: string } }>(`/api/projects/${id}/analyze`, { method: "POST" }); if (r.project.id !== id) router.push(`/p/${r.project.id}`); else reload(); } catch (e) { alert((e as Error).message); }
    setBusy(false);
  };

  return (
    <ProjectCtx.Provider value={ctx}>
      <div className="flex h-screen flex-col">
        <header className="flex flex-none flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-line bg-panel px-3 py-2 sm:px-4">
          <Brand />
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-0.5 text-[13px]">
            <span><span className="text-muted">Repository </span><strong>{project.owner ? `${project.owner}/` : ""}{project.name}</strong></span>
            {project.branch && <span><span className="text-muted">Branch </span><span className="mono">{project.branch}</span></span>}
            {project.commit && <span><span className="text-muted">Commit </span><span className="mono">{project.commit.slice(0, 10)}</span></span>}
            <span className="text-muted">Analysis </span><StatusChip status={project.status} />{project.imported && <Chip tone="info" title={`Opened from a Brody export made ${new Date(project.imported.exportedAt).toLocaleString()}. Nothing was re-analysed.`}>imported</Chip>}
            {ready && project.incremental && project.previousProjectId && <span className="text-xs text-muted" title="Compared with the previous analysis of this source">{project.incremental.changed} changed · {project.incremental.unchanged} unchanged · {project.incremental.added} added · {project.incremental.removed} removed</span>}
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto">
            {ready && <SearchBox projectId={id} />}
            {ready && <DownloadMenu projectId={id} scope="full" label="Export report" />}
            {ready && <button className="btn" onClick={reanalyze} disabled={busy} aria-busy={busy} title="Re-run the analysis (GitHub projects fetch the latest commit)">{busy ? "Starting…" : "Re-analyze"}</button>}
            <ThemeControl />
          </div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <aside className="flex-none border-b border-line bg-panel md:w-[220px] md:overflow-auto md:border-b-0 md:border-r md:px-2.5 md:py-3" aria-label="Sections">
            <nav className="flex gap-1 overflow-x-auto px-2 py-1.5 md:block md:space-y-0.5 md:p-0">
              {NAV.map((n) => {
                const href = n.slug ? `${base}/${n.slug}` : base;
                const active = n.slug ? pathname.startsWith(href) : pathname === base;
                return (
                  <Link key={n.slug} href={ready ? href : base} aria-current={active ? "page" : undefined} aria-disabled={!ready && !active ? true : undefined} tabIndex={!ready && !active ? -1 : undefined} className={`flex flex-none items-center gap-2.5 whitespace-nowrap rounded-full px-3.5 py-2 text-[13.5px] font-bold transition-colors hover:no-underline md:rounded-xl md:py-2 ${active ? "bg-fill text-on-fill" : "text-secondary hover:bg-panel2 hover:text-deep"} ${ready || active ? "" : "pointer-events-none opacity-50"}`}>
                    <Icon name={n.icon} size={17} />{n.label}
                    {n.slug === "review" && crit > 0 && <span className="ml-auto rounded-full px-1.5 text-[11px] font-bold tabular-nums" style={{ background: "var(--high)", color: "var(--bg)" }} title="Critical and high findings">{crit}</span>}
                  </Link>
                );
              })}
            </nav>
          </aside>
          <main className="min-w-0 flex-1 overflow-auto">{ready ? children : <AnalysisProgress project={project} reload={reload} />}</main>
        </div>
      </div>
    </ProjectCtx.Provider>
  );
}
