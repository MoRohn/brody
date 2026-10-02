/**
 * The grounding guard. A sentence may rephrase grounded material, but it may not introduce a new FACTUAL ATOM: a number,
 * a code identifier, a path, a quoted string or a proper name that appears nowhere in the claims, concepts and sources it
 * rests on. Narration, AI-restructured claims and refinement edits are all checked with it; a sentence that fails is
 * dropped and recorded, never shown or spoken. Browser-safe.
 */

const NUMBER_WORDS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000, half: 0.5, single: 1, both: 2, twice: 2, double: 2, once: 1 };
/** Numbers a sentence may use without grounding: counting words in ordinary speech. */
const FREE_NUMBERS = new Set([0, 1, 2, 3, 100]);
const STOP_PROPER = new Set(["I", "A", "An", "The", "This", "That", "These", "Those", "It", "Its", "Each", "Every", "One", "Two", "Three", "First", "Second", "Third", "Then", "Next", "Now", "Here", "There", "When", "While", "If", "So", "But", "And", "Or", "Because", "Instead", "Without", "With", "Without", "In", "On", "At", "For", "To", "By", "As", "Of", "From", "Before", "After", "No", "Not", "All", "Some", "Most", "Only", "Even", "Still", "Yet", "Imagine", "Picture", "Think", "Look", "Watch", "Notice", "Remember", "Consider", "Meanwhile", "Finally", "Together", "Over", "Under", "Why", "How", "What", "Where", "Who", "Which", "Our", "We", "You", "Your", "They", "Their", "Let", "Let's", "Once", "Until", "Unless", "Yes", "Today", "Brody", "OK", "Okay", "Same", "Other", "Another", "Many", "More", "Less", "Fewer", "Both", "Either", "Neither", "Nothing", "Everything", "Something", "Anything", "Same", "Such", "Also", "Just", "Again"]);

export interface Atom { kind: "number" | "identifier" | "quoted" | "proper"; value: string; norm: string }

function numberValue(raw: string): number | null {
  const s = raw.toLowerCase().replace(/,/g, "");
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s in NUMBER_WORDS) return NUMBER_WORDS[s];
  return null;
}

export function factualAtoms(sentence: string): Atom[] {
  const atoms: Atom[] = [];
  for (const m of sentence.matchAll(/`([^`]+)`/g)) atoms.push({ kind: "identifier", value: m[1], norm: m[1].toLowerCase() });
  for (const m of sentence.matchAll(/"([^"]{3,})"|“([^”]{3,})”/g)) { const v = m[1] ?? m[2]; atoms.push({ kind: "quoted", value: v, norm: v.toLowerCase() }); }
  const words = sentence.replace(/`[^`]+`/g, " ").split(/\s+/).filter(Boolean);
  words.forEach((raw, i) => {
    const w = raw.replace(/^[("'“‘[]+|[)"'”’\],.;:!?]+$/g, "");
    if (!w) return;
    // Numbers, with units and percentages.
    const num = w.match(/^~?(\d[\d,]*(?:\.\d+)?)(%|x|ms|s|gb|gib|mb|tb|k|m)?$/i);
    if (num) { const v = numberValue(num[1]); if (v !== null && !FREE_NUMBERS.has(v)) atoms.push({ kind: "number", value: w, norm: String(v) }); return; }
    const nw = numberValue(w);
    if (nw !== null) { if (!FREE_NUMBERS.has(nw)) atoms.push({ kind: "number", value: w, norm: String(nw) }); return; }
    // Code-like identifiers: dotted, slashed, snake_case, camelCase, calls.
    if (/[a-z][A-Z]|_|\(\)|[A-Za-z0-9]\.[A-Za-z]|[A-Za-z0-9]\/[A-Za-z0-9]|::/.test(w) && /[A-Za-z]/.test(w)) { atoms.push({ kind: "identifier", value: w, norm: w.toLowerCase().replace(/\(\)$/, "") }); return; }
    // Proper names: capitalised mid-sentence, or an acronym anywhere.
    const acronym = /^[A-Z][A-Z0-9]{1,6}s?$/.test(w);
    if ((acronym || (i > 0 && /^[A-Z][a-z]+[A-Za-z0-9-]*$/.test(w))) && !STOP_PROPER.has(w)) atoms.push({ kind: "proper", value: w, norm: w.toLowerCase().replace(/s$/, "") });
  });
  return atoms;
}

/** A searchable corpus: lowercased text plus every number it states (digits and number words). */
export interface Corpus { text: string; numbers: Set<string> }

export function buildCorpus(parts: string[]): Corpus {
  const text = parts.join("\n").toLowerCase();
  const numbers = new Set<string>();
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) numbers.add(String(Number(m[0].replace(/,/g, ""))));
  for (const w of text.split(/[^a-z]+/)) if (w in NUMBER_WORDS) numbers.add(String(NUMBER_WORDS[w]));
  // Percentages also appear as fractions ("0.12") and the reverse.
  for (const n of [...numbers]) { const v = Number(n); if (v > 0 && v < 1) numbers.add(String(Math.round(v * 100))); if (v > 1 && v <= 100) numbers.add(String(v / 100)); }
  return { text, numbers };
}

export function unsupportedAtoms(sentence: string, corpus: Corpus, o: { properNouns?: boolean } = {}): Atom[] {
  return factualAtoms(sentence).filter((a) => {
    if (a.kind === "proper" && o.properNouns === false) return false;
    if (a.kind === "number") return !corpus.numbers.has(a.norm);
    if (a.kind === "proper") return !corpus.text.includes(a.norm);
    return !corpus.text.includes(a.norm);
  });
}

/** `properNouns: false` for titles and headings, where Title Case makes every word look like a name. */
export function isGrounded(sentence: string, corpus: Corpus, o: { properNouns?: boolean } = {}): { ok: boolean; missing: string[] } {
  const missing = unsupportedAtoms(sentence, corpus, o).map((a) => a.value);
  return { ok: missing.length === 0, missing };
}
