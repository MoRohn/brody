import { Resvg } from "@resvg/resvg-js";
import { eq } from "drizzle-orm";
import { unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { buildBundle, importBundle } from "@/lib/bundle";
import { getDb, schema } from "@/lib/db/client";
import { deckOutline, deckSlides, ensureDeckContent, exportDeck } from "@/lib/deck";
import { declaredColors, loadBrandImages } from "@/lib/deck/brand";
import { slideText } from "@/lib/deck/scene";
import { brandPalette, C } from "@/lib/deck/theme";
import { pickVisuals, processImage, readmeImages } from "@/lib/ingest/visuals";
import { contrast, parseColor, toHex } from "@/lib/util/color";
import { analyze, fixtureFiles, freshDb } from "./helpers";

const png = (svg: string) => new Resvg(svg).render().asPng();
/** A product screenshot: a header bar and a few panels, 1200 x 750. */
const SCREEN = png(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="750"><rect width="1200" height="750" fill="#f6f7fb"/><rect width="1200" height="70" fill="#E4572E"/><rect x="40" y="110" width="520" height="280" rx="12" fill="#ffffff"/><rect x="600" y="110" width="560" height="280" rx="12" fill="#ffffff"/></svg>`);
const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="64" viewBox="0 0 240 64"><circle cx="32" cy="32" r="28" fill="#E4572E"/><rect x="72" y="20" width="150" height="24" rx="6" fill="#1D1D35"/></svg>`;
const LOGO_WHITE = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="64" viewBox="0 0 240 64"><circle cx="32" cy="32" r="28" fill="#FFFFFF"/><rect x="72" y="20" width="150" height="24" rx="6" fill="#FFFFFF"/></svg>`;

describe("colour parsing and brand palettes", () => {
  it("reads the colour syntaxes projects declare", () => {
    expect(toHex(parseColor("#e4572e")!)).toBe("#E4572E");
    expect(toHex(parseColor("#f00")!)).toBe("#FF0000");
    expect(toHex(parseColor("rgb(228, 87, 46)")!)).toBe("#E4572E");
    expect(toHex(parseColor("hsl(14 77% 54%)")!)).toBe(toHex(parseColor("14 77% 54%")!)); // shadcn's bare triplet
    expect(toHex(parseColor("oklch(0.628 0.258 29.2)")!)).toMatch(/^#F[0-9A-F]{5}$/); // a strong red
    for (const v of ["var(--x)", "transparent", "currentColor", "#ff000010", "linear-gradient(red, blue)"]) expect(parseColor(v)).toBeUndefined();
  });

  it("derives a readable palette in the brand's hue, and leaves Brody's own untouched", () => {
    for (const brand of ["#E4572E", "#FFD600", "#00C2A8", "#7C3AED", "#111111"]) {
      const P = brandPalette(brand);
      expect(contrast(P.accent, "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
      expect(contrast(P.navy, "#FFFFFF")).toBeGreaterThanOrEqual(9);
      expect(contrast(P.muted, P.mist)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(P.glow, P.deep)).toBeGreaterThanOrEqual(6.5);
      expect(contrast(P.onDarkSoft, P.deep)).toBeGreaterThanOrEqual(7);
      expect(P.crit).toBe(C.crit); // severity colours mean the same thing in every deck
    }
    expect(brandPalette("not a colour")).toEqual({ ...C });
  });
});

describe("finding a project's visuals", () => {
  it("picks logos, icons, social cards and screenshots by path, and skips dependencies, tests and starter images", () => {
    const files = ["public/logo.svg", "public/logo-white.svg", "app/icon.png", "public/og-image.png", "docs/screenshots/dashboard.png", "node_modules/x/logo.svg", "tests/fixtures/logo.png", "public/next.svg", "src/assets/photo.png", "README.md"].map((p) => ({ path: p, size: 2000 }));
    const picked = pickVisuals(files, [{ path: "README.md", text: "# App\n\n![The board](docs/board.png)\n" }]);
    const byPath = Object.fromEntries(picked.map((p) => [p.path, p]));
    expect(byPath["public/logo.svg"].kind).toBe("logo");
    expect(byPath["public/logo-white.svg"].forDark).toBe(true);
    expect(byPath["app/icon.png"].kind).toBe("icon");
    expect(byPath["public/og-image.png"].kind).toBe("hero");
    expect(byPath["docs/screenshots/dashboard.png"].kind).toBe("screenshot");
    for (const p of ["node_modules/x/logo.svg", "tests/fixtures/logo.png", "public/next.svg", "src/assets/photo.png"]) expect(byPath[p]).toBeUndefined();
  });

  it("resolves the images a README shows, and ignores remote ones", () => {
    expect(readmeImages("docs/README.md", '![Home](./img/home.png) ![badge](https://x.io/b.svg) <img src="../shot.jpg" alt="Shot">')).toEqual([
      { path: "docs/img/home.png", alt: "Home", order: 0 },
      { path: "shot.jpg", alt: "Shot", order: expect.any(Number) },
    ]);
  });

  it("renders images within bounds, measures their tone, and never follows an SVG's references", () => {
    const logo = processImage("logo.svg", Buffer.from(LOGO), "logo")!;
    expect(logo.mime).toBe("image/png");
    expect(Math.max(logo.width, logo.height)).toBe(720);
    expect(logo.meta.colors[0]).toMatch(/^#E/); // the orange mark
    expect(processImage("logo-white.svg", Buffer.from(LOGO_WHITE), "logo")!.meta.tone).toBe("light");
    const big = processImage("shot.png", SCREEN, "screenshot")!;
    expect([big.width, big.height]).toEqual([1200, 750]); // rasters are never scaled up
    expect(processImage("x.png", Buffer.from("not an image"), "logo")).toBeUndefined();
    const hostile = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10"><image xlink:href="file:///etc/hosts" width="10" height="10"/><rect width="10" height="10" fill="#123456"/></svg>`;
    expect(processImage("evil.svg", Buffer.from(hostile), "logo")?.meta.opaque).toBe(true); // drawn, minus the reference
  });

  it("reads declared brand colours, preferring the light theme's first definition", () => {
    const found = declaredColors([
      { path: "app/globals.css", text: ":root { --primary: 14 77% 54%; --primary-foreground: 0 0% 100%; }\n.dark { --primary: 200 50% 50%; }" },
      { path: "public/manifest.json", text: JSON.stringify({ theme_color: "#0F766E" }) },
      { path: "tailwind.config.ts", text: "export default { theme: { extend: { colors: { brand: { 50: '#fff', '500': '#7C3AED' } } } } }" },
    ]);
    expect(found.map((f) => [f.role, toHex(f.rgb), f.source])).toEqual([
      ["brand", "#7C3AED", "tailwind.config.ts"],
      ["primary", toHex(parseColor("14 77% 54%")!), "app/globals.css"],
      ["theme", "#0F766E", "public/manifest.json"],
    ]);
  });
});

describe("an executive deck in the project's own branding", () => {
  let pid: string;
  beforeAll(async () => {
    freshDb();
    const files = [
      ...fixtureFiles(),
      { path: "public/logo.svg", content: Buffer.from(LOGO) },
      { path: "public/logo-white.svg", content: Buffer.from(LOGO_WHITE) },
      { path: "docs/screenshots/dashboard.png", content: SCREEN },
      { path: "docs/screenshots/checkout-flow.png", content: SCREEN },
      { path: "styles/theme.css", content: Buffer.from(":root { --brand: #E4572E; }") },
    ];
    pid = (await analyze(files, "sample-shop")).projectId;
  }, 120_000);

  it("finds the logo, both variants, the screenshots and the declared colour, with their sources", () => {
    const b = ensureDeckContent(pid).brand!;
    expect(b.logo?.path).toBe("public/logo.svg");
    expect(b.logoOnDark?.path).toBe("public/logo-white.svg");
    expect(b.primary).toEqual({ color: "#E4572E", source: "styles/theme.css" });
    expect([b.hero?.path, ...b.screens.map((s) => s.path)].sort()).toEqual(["docs/screenshots/checkout-flow.png", "docs/screenshots/dashboard.png"]);
    expect(deckOutline(pid).brand).toMatchObject({ logo: true, colors: ["#E4572E", expect.any(String)], screens: 2 });
  });

  it("signs every page with the logo, shows the product on the cover and on its own slide, and credits the sources", () => {
    const d = deckSlides(pid);
    expect(d.palette.accent).not.toBe(C.accent);
    expect(d.slides.map((s) => s.id)).toContain("product");
    expect(d.slides.length).toBe(15);
    const title = d.slides[0];
    expect(title.prims.filter((p) => p.t === "image").length).toBe(2); // the logo for dark backgrounds, and the screenshot
    for (const s of d.slides.slice(1)) expect(s.prims.some((p) => p.t === "image" && p.ref === ensureDeckContent(pid).brand!.logo!.hash)).toBe(true);
    expect(slideText(d.slides.find((s) => s.id === "product")!).join(" ")).toMatch(/Checkout flow|Dashboard/);
    expect(slideText(d.slides.at(-1)!).join(" ")).toMatch(/Branding from.*public\/logo\.svg/);
    for (const p of d.slides.flatMap((s) => s.prims)) if (p.t === "image") expect(d.images[p.ref]).toBeDefined();
    expect(d.logo?.onDark).toBe(true);
  });

  it("draws the images in every format", async () => {
    const html = String((await exportDeck(pid, "html")).body);
    expect(html).toContain("<symbol id=\"img0\"");
    expect(html).toMatch(/<use href="#img\d+"/);
    expect(html).toContain('class="logo"');
    const pdf = (await exportDeck(pid, "pdf")).body as Buffer;
    expect(pdf.toString("latin1")).toContain("/Subtype /Image");
    const pptx = unzipSync(new Uint8Array((await exportDeck(pid, "pptx")).body as Buffer));
    expect(Object.keys(pptx).some((k) => /^ppt\/media\/.+\.(png|jpe?g)$/.test(k))).toBe(true);
  });

  it("can be drawn in Brody's style instead", async () => {
    const d = deckSlides(pid, { brand: false });
    expect(d.palette).toEqual({ ...C });
    expect(d.slides.some((s) => s.id === "product")).toBe(false);
    expect(d.slides.flatMap((s) => s.prims).some((p) => p.t === "image")).toBe(false);
    expect(String((await exportDeck(pid, "html", { brand: false })).body)).not.toContain("<symbol");
  });

  it("recovers an SVG logo for a project analysed before images were stored", () => {
    const logoHash = ensureDeckContent(pid).brand!.logo!.hash;
    getDb().delete(schema.images).where(eq(schema.images.hash, logoHash)).run();
    const p = getDb().select().from(schema.projects).where(eq(schema.projects.id, pid)).get()!;
    const { deck: _old, ...rest } = p.analysis as Record<string, unknown>;
    getDb().update(schema.projects).set({ analysis: rest }).where(eq(schema.projects.id, pid)).run();
    expect(ensureDeckContent(pid).brand!.logo!.path).toBe("public/logo.svg");
    expect(loadBrandImages(ensureDeckContent(pid).brand).has(logoHash)).toBe(true);
  });

  it("keeps its branding through a Brody export, re-encoding the images it carries", async () => {
    const bundle = await buildBundle(pid);
    expect(Object.keys(unzipSync(new Uint8Array(bundle.body))).filter((k) => k.startsWith("images/")).length).toBeGreaterThanOrEqual(3);
    const { projectId } = await importBundle(bundle.body);
    const b = ensureDeckContent(projectId).brand!;
    expect(b.logo?.path).toBe("public/logo.svg");
    expect(loadBrandImages(b).size).toBe(new Set([b.logo, b.logoOnDark, b.hero, ...b.screens].filter(Boolean).map((x) => x!.hash)).size);
    expect(deckSlides(projectId).slides.some((s) => s.id === "product")).toBe(true);
  });
});
