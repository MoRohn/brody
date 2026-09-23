import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, fmtBytes, fmtDuration, parseCite } from "@/lib/client";
import { countLines, escapeHtml, formatBytes, sliceLines, tokenize, truncate } from "@/lib/util/text";

/** The small helpers that most of the code base relies on (the self-analysis ranks them among the most depended-on files). */
describe("text helpers", () => {
  it("counts and slices lines by 1-based, inclusive line numbers", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a")).toBe(1);
    expect(countLines("a\nb\n")).toBe(3);
    const t = "one\ntwo\nthree\nfour";
    expect(sliceLines(t, 2, 3)).toBe("two\nthree");
    expect(sliceLines(t, 0, 1)).toBe("one");
    expect(sliceLines(t, 4, 2)).toBe("four");
    expect(sliceLines(t, 3, 99)).toBe("three\nfour");
  });
  it("truncates with a note of how much was cut", () => {
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("abcdefghij", 4)).toBe("abcd\n… [truncated 6 chars]");
  });
  it("splits identifiers into search terms across naming styles", () => {
    expect(tokenize("getUserByID")).toEqual(["get", "user", "by", "id"]);
    expect(tokenize("HTTPServer_config-file/path.ts")).toEqual(["http", "server", "config", "file", "path", "ts"]);
    expect(tokenize("a b")).toEqual([]);
  });
  it("formats sizes and escapes HTML", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 ** 2)).toBe("5.0 MB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.00 GB");
    expect(escapeHtml(`<a href="x">&</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });
});

describe("client helpers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("formats durations and parses citations", () => {
    expect(fmtDuration(4_400)).toBe("4s");
    expect(fmtDuration(125_000)).toBe("2m 5s");
    expect(parseCite("src/a.ts:12-30")).toEqual({ path: "src/a.ts", line: 12, end: 30 });
    expect(parseCite("src/a.ts:7")).toEqual({ path: "src/a.ts", line: 7, end: undefined });
    expect(parseCite("package.json")).toEqual({ path: "package.json" });
    expect(fmtBytes(0)).toMatch(/0/);
  });
  it("returns JSON, sends JSON bodies with a content type, and leaves form uploads alone", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await api<{ ok: number }>("/api/x", { method: "POST", body: JSON.stringify({ a: 1 }) })).toEqual({ ok: 1 });
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ "Content-Type": "application/json" });
    await api("/api/x", { method: "POST", body: new FormData() });
    expect((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].headers).toBeUndefined();
  });
  it("turns server errors, non-JSON replies and network failures into ApiError with a usable message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "analysis_not_ready", message: "Not yet.", hint: "Wait." } }), { status: 409 })));
    await expect(api("/api/x")).rejects.toMatchObject({ code: "analysis_not_ready", status: 409, message: "Not yet.", hint: "Wait." });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 })));
    await expect(api("/api/x")).rejects.toMatchObject({ code: "http_error", status: 502, message: "Request failed with status 502." });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const e = await api("/api/x").catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ code: "network", status: 0 });
  });
});
