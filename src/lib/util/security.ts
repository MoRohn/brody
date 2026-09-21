/**
 * Headers for HTML that Brody generates from analysed repositories and serves inline. The text is escaped, but a page opened
 * from the app runs under the app's own origin, so it is also sandboxed: it gets a throwaway origin (no access to the app's
 * API or storage), may only run its own inline script, and cannot make requests or navigate forms. `cdn` lists the one
 * external script host a page may load (the report's diagrams use Mermaid).
 */
export function htmlSecurityHeaders(opts: { cdn?: string } = {}): Record<string, string> {
  const script = ["'unsafe-inline'", ...(opts.cdn ? [opts.cdn] : [])].join(" ");
  return {
    "Content-Security-Policy": [
      "default-src 'none'", `script-src ${script}`, "style-src 'unsafe-inline'", "img-src data:", "font-src data:", "connect-src 'none'",
      "base-uri 'none'", "form-action 'none'", "frame-ancestors 'self'", "sandbox allow-scripts allow-modals",
    ].join("; "),
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}
