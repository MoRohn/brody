"use client";
import { useEffect, useId, useRef, useState } from "react";
import { useThemeLevel } from "@/lib/themeState";

/** Renders Mermaid source client-side, falling back to the source text if rendering fails. */
export function MermaidView({ code, title }: { code: string; title?: string }) {
  const level = useThemeLevel();
  const ref = useRef<HTMLDivElement>(null);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [visible, setVisible] = useState(false);
  // Mermaid is large; it is only downloaded once the diagram is about to scroll into view.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { setVisible(true); io.disconnect(); } }, { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        // Read the live palette so diagrams match the brightness level, and re-render when it changes.
        const css = getComputedStyle(document.documentElement);
        const v = (name: string) => css.getPropertyValue(name).trim();
        const themeVariables = {
          primaryColor: v("--panel2"), primaryTextColor: v("--fg"), primaryBorderColor: v("--line-strong"), secondaryColor: v("--panel"), tertiaryColor: v("--panel"),
          lineColor: v("--muted"), textColor: v("--fg"), background: v("--panel"), edgeLabelBackground: v("--panel"), nodeBorder: v("--line-strong"),
          mainBkg: v("--panel2"), clusterBkg: v("--panel"), clusterBorder: v("--line-strong"), titleColor: v("--deep"),
          // Entity-relationship diagrams: a tinted header, alternating attribute rows, and text that reads on both.
          attributeBackgroundColorOdd: v("--panel"), attributeBackgroundColorEven: v("--panel2"), entityBkg: v("--panel2"), entityBorder: v("--line-strong"),
        };
        mermaid.initialize({
          startOnLoad: false, theme: "base", themeVariables, securityLevel: "strict",
          // Labels are drawn as plain SVG text. HTML labels live in <foreignObject>, which is stripped below for safety, and that removed all text from ER diagrams.
          htmlLabels: false,
          // Mermaid paints alternating ER rows from its own palette and ignores the row variables in some versions, so the rows are set here. The rules read the page's live CSS variables, which keeps diagrams correct at every brightness level.
          themeCSS: ".row-rect-odd path, .row-rect-odd rect { fill: var(--panel) !important; } .row-rect-even path, .row-rect-even rect { fill: var(--panel2) !important; } .node .outer-path { stroke: var(--line-strong) !important; } .relationshipLine { stroke: var(--muted) !important; } .marker.er * { stroke: var(--muted) !important; } .edgeLabel .label text, .edgeLabel text { fill: var(--fg) !important; }",
          flowchart: { htmlLabels: false, curve: "basis", useMaxWidth: false }, er: { useMaxWidth: false, layoutDirection: "TB", minEntityWidth: 120, fontSize: 13 }, fontFamily: getComputedStyle(document.body).fontFamily,
        });
        const { svg } = await mermaid.render(`m${uid}${Math.random().toString(36).slice(2, 7)}`, code);
        if (!cancelled && ref.current) {
          // Parse the SVG and drop scripts, foreign objects and event handlers before inserting it into the page.
          const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
          if (doc.querySelector("parsererror")) throw new Error("Mermaid returned invalid SVG");
          doc.querySelectorAll("script, foreignObject").forEach((n) => n.remove());
          doc.querySelectorAll("*").forEach((n) => { for (const a of [...n.attributes]) if (/^on/i.test(a.name) || /^\s*javascript:/i.test(a.value)) n.removeAttribute(a.name); });
          ref.current.replaceChildren(document.importNode(doc.documentElement, true));
          setErr(null);
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [code, uid, visible, level]);

  return (
    <figure className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-line bg-panel2 px-3 py-1">
        <figcaption className="text-xs text-muted">{title ?? "Diagram"}</figcaption>
        <button className="btn py-0 text-xs" onClick={() => { navigator.clipboard?.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>{copied ? "Copied" : "Copy Mermaid"}</button>
      </div>
      {err ? (
        <div className="p-3"><div className="mb-1 text-xs" style={{ color: "var(--med)" }}>The diagram could not be rendered ({err.slice(0, 120)}). Source shown instead.</div><pre tabIndex={0} className="max-h-72">{code}</pre></div>
      ) : (
        <div ref={ref} tabIndex={0} className="overflow-auto p-3 [&_svg]:mx-auto [&_svg]:max-h-[520px]" role="img" aria-label={title ?? "Diagram"} />
      )}
    </figure>
  );
}
