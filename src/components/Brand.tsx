import Link from "next/link";

/** The wordmark: "Brody" set in a wide geometric face, with the "o" drawn as a graph node (a ring around a dot). */
export function Wordmark({ className = "" }: { className?: string }) {
  return <span className={`wordmark ${className}`}>Br<span className="wordmark-o" />dy</span>;
}

export const TAGLINE = "Repo intel and code review, bro";

/** The wordmark with its subtitle below it. Text only, no logo tile. Links home. */
export function Brand({ tagline = TAGLINE }: { tagline?: string | null }) {
  return (
    <Link href="/" className="flex min-w-0 flex-col justify-center leading-tight hover:no-underline" title="All projects" aria-label="Brody, all projects">
      <span className="block truncate" aria-hidden><Wordmark /></span>
      {tagline && <span className="mt-1 block truncate text-[12.5px] font-medium text-muted">{tagline}</span>}
    </Link>
  );
}
