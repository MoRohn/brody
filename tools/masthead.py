"""Brody README masthead: the UI header wordmark (Unbounded 700, ring "o"), tagline (Geist 500), code-map motif.

Text is shaped with HarfBuzz (kerning, as the browser does) and outlined, since GitHub serves SVG as an image
without web fonts. The ring "o" is rebuilt from .wordmark-o in src/app/globals.css, and the colours are the Default
and Dark brightness levels. Writes <out>/masthead-light.svg and <out>/masthead-dark.svg.

  pip install fonttools uharfbuzz
  curl -sSfLo Unbounded.ttf "https://github.com/google/fonts/raw/main/ofl/unbounded/Unbounded%5Bwght%5D.ttf"
  curl -sSfLo Geist.ttf "https://github.com/google/fonts/raw/main/ofl/geist/Geist%5Bwght%5D.ttf"
  python3 tools/masthead.py docs/brand Unbounded.ttf Geist.ttf
"""
import io, sys
import uharfbuzz as hb
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

OUT = sys.argv[1]

def load(path, wght):
    font = instantiateVariableFont(TTFont(path), {"wght": wght})
    buf = io.BytesIO(); font.save(buf); data = buf.getvalue()
    return TTFont(io.BytesIO(data)), hb.Font(hb.Face(data))

def shape(pair, text, size, x, baseline, tracking_em=0.0):
    """Outline `text` at `size` px with its left edge at x and baseline at `baseline`. Returns (path d, advance)."""
    tt, hbfont = pair
    upem = tt["head"].unitsPerEm
    buf = hb.Buffer(); buf.add_str(text); buf.guess_segment_properties()
    hb.shape(hbfont, buf, {"kern": True, "liga": True})
    gs = tt.getGlyphSet(); order = tt.getGlyphOrder()
    s = size / upem
    d = []; pen_x = 0.0
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        pen = SVGPathPen(gs)
        gx = x + (pen_x + pos.x_offset) * s
        gs[order[info.codepoint]].draw(TransformPen(pen, (s, 0, 0, -s, gx, baseline - pos.y_offset * s)))
        d.append(pen.getCommands())
        pen_x += pos.x_advance + tracking_em * upem
    return " ".join(d), pen_x * s

BRAND = load(sys.argv[2], 700)
SANS = load(sys.argv[3], 500)

W, H = 1280, 400
SIZE = 132                      # wordmark font size in px
TRACK = -0.045                  # .wordmark letter-spacing
X0, BASE = 96, 212

def ring(cx_left, baseline, em, deep, accent, name):
    """.wordmark-o: .53em box, .125em white border, .035em edges in the text colour, .18em accent dot, raised .02em."""
    d = .53 * em; R = d / 2
    cx = cx_left + R; cy = baseline - .02 * em - R
    b, e = .125 * em, .035 * em
    return (f'<g id="{name}">'
            f'<circle cx="{cx:.2f}" cy="{cy:.2f}" r="{R + e/2:.2f}" fill="none" stroke="{deep}" stroke-width="{e:.2f}"/>'
            f'<circle cx="{cx:.2f}" cy="{cy:.2f}" r="{R - b/2:.2f}" fill="none" stroke="#fff" stroke-width="{b:.2f}"/>'
            f'<circle cx="{cx:.2f}" cy="{cy:.2f}" r="{R - b - e/2:.2f}" fill="none" stroke="{deep}" stroke-width="{e:.2f}"/>'
            f'<circle cx="{cx:.2f}" cy="{cy:.2f}" r="{.09 * em:.2f}" fill="{accent}"/></g>'), cx, cy, R

def node(cx, cy, r, deep, accent, bg, strong=False):
    """A code-map node in the style of the ring "o", scaled to radius r."""
    em = r / .265; b, e = .125 * em, .035 * em
    op = "1" if strong else ".9"
    return (f'<g opacity="{op}"><circle cx="{cx}" cy="{cy}" r="{r + e/2:.2f}" fill="{bg}" stroke="{deep}" stroke-width="{e:.2f}"/>'
            f'<circle cx="{cx}" cy="{cy}" r="{r - b/2:.2f}" fill="none" stroke="#fff" stroke-width="{b:.2f}"/>'
            f'<circle cx="{cx}" cy="{cy}" r="{r - b - e/2:.2f}" fill="none" stroke="{deep}" stroke-width="{e:.2f}"/>'
            f'<circle cx="{cx}" cy="{cy}" r="{.09 * em:.2f}" fill="{accent}"/></g>')

def masthead(t):
    br, adv_br = shape(BRAND, "Br", SIZE, X0, BASE, TRACK)
    ox = X0 + adv_br + .02 * SIZE
    o, cx, cy, R = ring(ox, BASE, SIZE, t["deep"], t["accent"], "o")
    dy, adv_dy = shape(BRAND, "dy", SIZE, ox + .53 * SIZE + .05 * SIZE, BASE, TRACK)
    tag, _ = shape(SANS, "Repo intel and code review, bro", 34, X0 + 4, BASE + 70)

    # Code map motif: layered nodes and edges, one highlighted path, drawn in the palette's line and accent colours.
    nodes = {"a": (820, 118, 22), "b": (960, 92, 16), "c": (1100, 138, 20), "d": (905, 238, 18),
             "e": (1045, 262, 24), "f": (1180, 222, 15), "g": (800, 318, 14), "h": (1150, 330, 16)}
    edges = [("a", "b"), ("b", "c"), ("a", "d"), ("d", "e"), ("c", "e"), ("e", "f"), ("d", "g"), ("e", "h"), ("b", "e")]
    hot = {("a", "d"), ("d", "e"), ("e", "f")}
    def curve(p, q):
        (x1, y1, _), (x2, y2, _) = nodes[p], nodes[q]
        mx = (x1 + x2) / 2
        return f"M{x1} {y1} C{mx} {y1} {mx} {y2} {x2} {y2}"
    def edge(p, q):
        on = (p, q) in hot
        return (f'<path d="{curve(p, q)}" fill="none" stroke="{t["accent"] if on else t["line"]}" '
                f'stroke-width="{3 if on else 2.2}" stroke-linecap="round" opacity="{1 if on else .9}"/>')
    lines = "".join(edge(p, q) for p, q in edges)
    dots = "".join(node(x, y, r, t["deep"], t["accent"], t["bg"], k in {"a", "d", "e", "f"}) for k, (x, y, r) in nodes.items())

    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-labelledby="t d">
<title id="t">Brody</title>
<desc id="d">Brody: repo intel and code review, bro. The wordmark's "o" is drawn as a code-map node, beside a small dependency graph.</desc>
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{t["bg"]}"/><stop offset="1" stop-color="{t["panel2"]}"/></linearGradient>
<radialGradient id="glow" cx="0.78" cy="0.5" r="0.45"><stop offset="0" stop-color="{t["accent"]}" stop-opacity="{t["glow"]}"/><stop offset="1" stop-color="{t["accent"]}" stop-opacity="0"/></radialGradient>
<pattern id="grid" width="28" height="28" patternUnits="userSpaceOnUse"><circle cx="1.5" cy="1.5" r="1.5" fill="{t["line"]}" opacity=".55"/></pattern>
<clipPath id="card"><rect width="{W}" height="{H}" rx="28"/></clipPath>
</defs>
<g clip-path="url(#card)">
<rect width="{W}" height="{H}" fill="url(#bg)"/>
<rect x="700" width="{W - 700}" height="{H}" fill="url(#grid)" opacity=".6"/>
<rect width="{W}" height="{H}" fill="url(#glow)"/>
{lines}
{dots}
<path d="{br}" fill="{t["deep"]}"/>
{o}
<path d="{dy}" fill="{t["deep"]}"/>
<path d="{tag}" fill="{t["muted"]}"/>
<rect x="{X0 + 4}" y="{BASE + 106}" width="56" height="5" rx="2.5" fill="{t["accent"]}"/>
</g>
<rect x=".75" y=".75" width="{W - 1.5}" height="{H - 1.5}" rx="27.25" fill="none" stroke="{t["line"]}" stroke-width="1.5"/>
</svg>
'''

LIGHT = {"bg": "#d2e0e9", "panel2": "#c8d9e4", "line": "#b1c7d6", "muted": "#3b5163", "deep": "#0f2f45", "accent": "#006c96", "glow": ".10"}
DARK = {"bg": "#15283a", "panel2": "#0f202d", "line": "#37536b", "muted": "#a4bccd", "deep": "#eaf6fc", "accent": "#58b8e2", "glow": ".16"}
for name, theme in (("light", LIGHT), ("dark", DARK)):
    with open(f"{OUT}/masthead-{name}.svg", "w") as f:
        f.write(masthead(theme))
    print(f"{OUT}/masthead-{name}.svg")
