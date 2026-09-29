"use client";
import { useState } from "react";
import { api, useApi } from "@/lib/client";
import { Spinner } from "./ui";

export interface FormalStatus {
  enabled: boolean;
  lean: string | null;
  reason?: string;
  canInstall: boolean;
  installBlocked?: string;
  install: { state: "idle" | "installing" | "done" | "failed"; step?: string; error?: string };
}

/** Lean readiness from /api/status, polled while an install is running. */
export function useFormalStatus() {
  const [polling, setPolling] = useState(false);
  const status = useApi<{ formal: FormalStatus }>("/api/status", { pollMs: polling ? 2000 : undefined, stop: (d) => d.formal.install.state !== "installing" });
  return { formal: status.data?.formal ?? null, polling, reload: status.reload, setPolling };
}

/**
 * The automatic Lean check and the one-click Add Lean button. Shows nothing when Lean is ready (unless it was just
 * installed) or formal verification is turned off.
 */
export function LeanSetup({ context }: { context: "home" | "proofs" }) {
  const { formal, polling, setPolling, reload } = useFormalStatus();
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  if (!formal || !formal.enabled) return null;
  const { install } = formal;
  // "Ready" is shown only where the install was started, not on every later visit.
  const justInstalled = polling && install.state === "done" && formal.lean;
  const installing = starting || install.state === "installing";
  if (formal.lean && !justInstalled) return null;

  const add = async () => {
    setError(null);
    setStarting(true);
    try {
      await api("/api/formal/lean", { method: "POST", body: "{}" });
      setPolling(true);
      reload();
    } catch (e) {
      const err = e as Error & { hint?: string };
      setError([err.message, err.hint].filter(Boolean).join(" "));
    } finally {
      setStarting(false);
    }
  };

  const then = context === "proofs" ? "Re-analyze the project to run the proofs." : "New analyses will include formal proofs.";
  const border = justInstalled ? "var(--ok)" : install.state === "failed" || error ? "var(--crit)" : "var(--med)";
  return (
    <div role="status" data-testid="lean-setup" className="card mt-4 px-3 py-2 text-left text-sm" style={{ borderColor: border }}>
      {justInstalled ? (
        <><strong>Lean {formal.lean} is ready.</strong> {then}</>
      ) : installing ? (
        <span className="inline-flex items-center gap-2"><Spinner /> <span><strong>Adding Lean…</strong> {install.step ?? "Starting"}. This downloads about 300 MB and can take a few minutes.</span></span>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>
            <strong>Formal proofs are off: Lean 4 is not available.</strong>{" "}
            {install.state === "failed" ? <>The last attempt failed: {install.error}</> : formal.canInstall ? "Brody can install it for you (elan and the Lean toolchain, into ~/.elan)." : formal.installBlocked ?? formal.reason}
            {error && <span className="block" style={{ color: "var(--crit)" }}>{error}</span>}
          </span>
          {formal.canInstall && <button type="button" className="btn btn-primary" onClick={add}>{install.state === "failed" ? "Try again" : "Add Lean"}</button>}
        </div>
      )}
    </div>
  );
}
