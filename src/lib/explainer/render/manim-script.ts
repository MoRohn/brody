/**
 * The Manim scene interpreter, written to each scene's work directory and run with the configured Python. It draws the
 * scene JSON produced by the scene planner with Manim's own animations, so the Manim and SVG renderers show the same
 * objects in the same places at the same times.
 *
 * Safeguards adapted from the explainer-video reference implementation (MIT, Paul Lemaistre):
 *  - beats are placed with hold_until(t) against self.renderer.time, Manim's REAL clock, never against summed run_time
 *    values (Manim rounds every animation up to whole frames, and the rounding accumulates);
 *  - rendering always uses --disable_caching: on a cache hit Manim advances its clock by the nominal run time, which
 *    makes hold_until read a clock that lies; the script refuses to run with caching on;
 *  - dimming is a scrim laid over the picture, never set_opacity() (which switches on fills that outline shapes never had);
 *    every outline shape is built with fill_color = ground and fill_opacity = 0 as a second guard;
 *  - highlights are an outline added over the object, never Indicate() (which scales the target out from under overlays);
 *  - text is built four times larger and scaled down to its measured width (spaces collapse at some Manim font sizes);
 *  - values change through a ValueTracker and become(), never by swapping a VGroup's children inside an updater.
 */
export const MANIM_SCRIPT_VERSION = 4;

export const MANIM_SCRIPT = String.raw`
import json, math, os, sys
from manim import *
import manimpango

MODEL = json.load(open(os.environ["BRODY_SCENE_MODEL"], encoding="utf-8"))
for f in MODEL["fonts"]:
    manimpango.register_font(f)

P = MODEL["palette"]
W, H = 1280.0, 720.0
FW, FH = config.frame_width, config.frame_height
SANS, MONO = MODEL["fontSans"], MODEL["fontMono"]

SW = 1.0 / (0.01 * W / FW)

def ux(x): return (x / W - 0.5) * FW
def uy(y): return (0.5 - y / H) * FH
def ul(px): return px / W * FW
def pt(x, y): return np.array([ux(x), uy(y), 0.0])

DESC = set("gjpqy,;()[]{}|_/@$Q")

# Cap height of "H" per unit of font_size, measured once, so every text is scaled to its true pixel size.
_CAP = {}
def cap_per_size(mono, bold):
    key = (mono, bold)
    if key not in _CAP:
        ref = Text("H", font=MONO if mono else SANS, font_size=100, weight=BOLD if bold else NORMAL)
        _CAP[key] = ref.height / 100.0
    return _CAP[key]

def text_line(s, x, baseline, size, color, width_px, bold=False, mono=False, anchor="start", opacity=1.0):
    if not s.strip():
        return None
    # Built four times larger, then scaled down: Manim collapses spaces at some small sizes.
    t = Text(s, font=MONO if mono else SANS, font_size=size * 4, weight=BOLD if bold else NORMAL, color=color)
    t.scale(ul(0.729 * size) / (cap_per_size(mono, bold) * size * 4))
    # Never wider than the layout measured, whatever face the system resolved.
    if width_px > 0 and t.width > ul(width_px) * 1.02:
        t.scale_to_fit_width(ul(width_px))
    bottom = baseline + (0.21 * size if any(c in DESC for c in s) else 0)
    t.move_to(np.array([0, 0, 0]))
    t.shift(np.array([0, uy(bottom) - t.get_bottom()[1], 0]))
    if anchor == "start":
        t.shift(np.array([ux(x) - t.get_left()[0], 0, 0]))
    elif anchor == "middle":
        t.shift(np.array([ux(x) - t.get_center()[0], 0, 0]))
    else:
        t.shift(np.array([ux(x) - t.get_right()[0], 0, 0]))
    if opacity < 1:
        t.set_fill(opacity=opacity)
    return t

def baseline(top, i, size):
    return top + i * round(size * 1.28) + size * 0.986

def rect(b, stroke, width, fill=None, radius=0.0, pad=0.0):
    r = RoundedRectangle(corner_radius=max(0.001, ul(min(radius, (b["h"] + 2 * pad) / 2 - 0.5))), width=ul(b["w"] + 2 * pad), height=ul(b["h"] + 2 * pad),
                         stroke_color=stroke, stroke_width=width,
                         fill_color=fill if fill else P["ground"], fill_opacity=1.0 if fill else 0.0)
    r.move_to(pt(b["x"] + b["w"] / 2, b["y"] + b["h"] / 2))
    return r

def glyph(name, x, y, size, color):
    g = VGroup()
    k = size / 24.0
    for p in MODEL["glyphs"].get(name, MODEL["glyphs"]["generic"]):
        sw = 1.5 * k * SW
        if p["t"] == "rect":
            m = RoundedRectangle(corner_radius=max(0.001, ul(p.get("r", 0) * k)), width=ul(p["w"] * k), height=p["h"] * k / H * FH, stroke_color=color, stroke_width=sw, fill_color=P["ground"], fill_opacity=0.0)
            m.move_to(pt(x + (p["x"] + p["w"] / 2) * k, y + (p["y"] + p["h"] / 2) * k))
        elif p["t"] == "circle":
            m = Circle(radius=ul(p["r"] * k), stroke_color=color, stroke_width=sw, fill_color=color if p.get("fill") else P["ground"], fill_opacity=1.0 if p.get("fill") else 0.0)
            m.move_to(pt(x + p["cx"] * k, y + p["cy"] * k))
        elif p["t"] == "line":
            m = Line(pt(x + p["x1"] * k, y + p["y1"] * k), pt(x + p["x2"] * k, y + p["y2"] * k), stroke_color=color, stroke_width=sw)
        else:
            pts = [pt(x + a * k, y + b * k) for a, b in p["pts"]]
            if p.get("closed"):
                m = Polygon(*pts, stroke_color=color, stroke_width=sw, fill_color=P["ground"], fill_opacity=0.0)
            else:
                m = VMobject(stroke_color=color, stroke_width=sw, fill_color=P["ground"], fill_opacity=0.0)
                m.set_points_as_corners(pts)
        g.add(m)
    return g

def state_color(s):
    return {"busy": P["accent"], "blocked": P["signal"], "waiting": P["waiting"], "ok": P["ok"]}.get(s or "idle", P["rule"])

def cell_fill(s):
    base = {"busy": P["cellBusy"], "ok": P["cellOk"], "blocked": P["cellBlocked"]}
    return base.get(s or "idle", P["panelRaised"])


class Obj:
    def __init__(self, o):
        self.o = o
        self.group = VGroup()
        self.box = None
        self.outline = None
        self.sub = None
        self.meter = None
        self.tracker = None
        self.path = None
        self.glyph = None

def build(o, scene):
    ob = Obj(o)
    b = o["box"]
    k = o["kind"]
    st = o["initial"].get("state") or "idle"
    L = o["lines"]
    W_ = o.get("widths", [])
    def w(i):
        return W_[i] if i < len(W_) else 0
    g = ob.group
    if k == "kicker":
        g.add(Rectangle(width=ul(22), height=4 / H * FH, stroke_width=0, fill_color=P["accent"], fill_opacity=1).move_to(pt(b["x"] + 11, b["y"] + 12)))
        t0 = text_line(o.get("sub", [""])[0], b["x"] + 32, baseline(b["y"], 0, o["fontSize"]) - 4, 15, P["inkSecondary"], o.get("subWidths", [0])[0], mono=True)
        t1 = text_line(L[0] if L else "", b["x"] + 62, baseline(b["y"], 0, o["fontSize"]) - 4, o["fontSize"], P["accent"], w(0), bold=True)
        for t in (t0, t1):
            if t: g.add(t)
    elif k == "statement":
        for i, line in enumerate(L):
            t = text_line(line, b["x"], baseline(b["y"], i, o["fontSize"]), o["fontSize"], P["ink"], w(i), bold=o.get("bold", False))
            if t: g.add(t)
    elif k == "group":
        ob.box = rect(b, state_color(st), 1.6 * SW, P["panel"], 14)
        g.add(ob.box)
        if o.get("glyph"):
            ob.glyph = glyph(o["glyph"], b["x"] + 16, b["y"] + 14, 22, P["inkSecondary"]); g.add(ob.glyph)
        t = text_line(L[0] if L else "", b["x"] + 46, baseline(b["y"] + 12, 0, o["fontSize"]) - 2, o["fontSize"], P["ink"], w(0), bold=True)
        if t: g.add(t)
        ob.outline = rect(b, P["accent"], 2.4 * SW, None, 19, 5)
    elif k == "node":
        if o.get("plain"):
            for i, line in enumerate(L):
                t = text_line(line, b["x"], baseline(b["y"] - 2, i, o["fontSize"]), o["fontSize"], P["inkSecondary"], w(i))
                if t: g.add(t)
            ob.outline = rect(b, P["accent"], 2.4 * SW, None, 16, 6)
        else:
            ob.box = rect(b, state_color(st), 1.6 * SW, P["panelRaised"], 10)
            g.add(ob.box)
            step = (o.get("sub") or [None])[0]
            if step:
                c = Circle(radius=ul(12), stroke_color=P["accent"], stroke_width=1.6 * SW, fill_color=P["ground"], fill_opacity=0.0).move_to(pt(b["x"] + 22, b["y"] + 22))
                g.add(c)
                t = text_line(step, b["x"] + 22, b["y"] + 27.5, 15, P["accent"], o.get("subWidths", [0])[0], bold=True, anchor="middle")
                if t: g.add(t)
                for i, line in enumerate(L):
                    t = text_line(line, b["x"] + 16, baseline(b["y"] + 42, i, o["fontSize"]), o["fontSize"], P["ink"], w(i))
                    if t: g.add(t)
            else:
                has_cells = o.get("hasCells", False)
                gy = b["y"] + 13 if has_cells else b["y"] + b["h"] / 2 - 12
                if o.get("glyph"):
                    ob.glyph = glyph(o["glyph"], b["x"] + 14, gy, 24, P["inkSecondary"] if st == "idle" else state_color(st)); g.add(ob.glyph)
                top = b["y"] + 10 if has_cells else b["y"] + (b["h"] - len(L) * round(o["fontSize"] * 1.28)) / 2
                for i, line in enumerate(L):
                    t = text_line(line, b["x"] + (48 if o.get("glyph") else 16), baseline(top, i, o["fontSize"]), o["fontSize"], P["ink"], w(i))
                    if t: g.add(t)
            ob.outline = rect(b, P["accent"], 2.4 * SW, None, 15, 5)
    elif k == "cell":
        ob.box = rect(b, P["hairline"] if st == "idle" else state_color(st), (1.2 if st == "idle" else 1.8) * SW, cell_fill(st), 6)
        g.add(ob.box)
        big = b["h"] >= 50
        if not big:
            t = text_line(L[0] if L else "", b["x"] + b["w"] / 2, b["y"] + b["h"] / 2 + 5.5, o["fontSize"], P["inkSecondary"], w(0), anchor="middle")
            if t: g.add(t)
        else:
            t = text_line(L[0] if L else "", b["x"] + 9, b["y"] + 21, o["fontSize"], P["ink"], w(0))
            if t: g.add(t)
            sub = (o.get("sub") or [""])
            sub = sub[0] if sub else ""
            if sub:
                ob.sub = text_line(sub, b["x"] + 9, b["y"] + 41, 16, P["ok"] if st == "ok" else P["inkSecondary"], o.get("subWidths", [0])[0])
                if ob.sub: g.add(ob.sub)
            if o.get("value") is not None:
                tw = b["w"] - 18
                ty = b["y"] + b["h"] - 15
                track = Rectangle(width=ul(tw), height=7 / H * FH, stroke_width=0, fill_color=P["track"], fill_opacity=1).move_to(pt(b["x"] + 9 + tw / 2, ty + 3.5))
                g.add(track)
                ob.tracker = ValueTracker(float(o.get("value") or 0))
                def make_fill(tr=ob.tracker, x0=b["x"] + 9, ty=ty, tw=tw):
                    v = max(0.0, min(1.0, tr.get_value()))
                    wpx = max(0.5, tw * v)
                    return Rectangle(width=ul(wpx), height=7 / H * FH, stroke_width=0, fill_color=P["accent"], fill_opacity=1 if v > 0.002 else 0).move_to(pt(x0 + wpx / 2, ty + 3.5))
                ob.meter = make_fill()
                ob.meter.add_updater(lambda m, f=make_fill: m.become(f()))
                g.add(ob.meter)
        ob.outline = rect(b, P["accent"], 2.4 * SW, None, 10, 4)
    elif k == "connector":
        pts = [pt(p["x"], p["y"]) for p in o["points"]]
        color = P["accent"] if o.get("tone") == "accent" else P["rule"]
        line = VMobject(stroke_color=color, stroke_width=(3 if o.get("tone") == "accent" else 1.8) * SW, fill_color=P["ground"], fill_opacity=0.0)
        line.set_points_as_corners(pts)
        ob.path = line
        if o.get("dashed"):
            line = DashedVMobject(line, num_dashes=max(4, int(sum(np.linalg.norm(pts[i + 1] - pts[i]) for i in range(len(pts) - 1)) / ul(12))))
        g.add(line)
        if o.get("tone") != "accent":
            a, z = o["points"][-2], o["points"][-1]
            ang = math.atan2(z["y"] - a["y"], z["x"] - a["x"])
            Lh, Wh = 9, 5
            tip = Polygon(pt(z["x"], z["y"]), pt(z["x"] - Lh * math.cos(ang) + Wh * math.sin(ang), z["y"] - Lh * math.sin(ang) - Wh * math.cos(ang)), pt(z["x"] - Lh * math.cos(ang) - Wh * math.sin(ang), z["y"] - Lh * math.sin(ang) + Wh * math.cos(ang)), stroke_width=0, fill_color=color, fill_opacity=1)
            g.add(tip)
    elif k == "chip":
        acc = o.get("tone") == "accent"
        ob.box = rect(b, P["accent"] if acc else P["hairline"], (1.8 if acc else 1.2) * SW, P["ground"], b["h"] / 2)
        g.add(ob.box)
        t = text_line(L[0] if L else "", b["x"] + b["w"] / 2, b["y"] + b["h"] / 2 + o["fontSize"] * 0.36, o["fontSize"], P["accent"] if acc else P["inkSecondary"], w(0), bold=o.get("bold", False), anchor="middle")
        if t: g.add(t)
        ob.outline = rect(b, P["accent"], 2.4 * SW, None, b["h"] / 2 + 4, 4)
    elif k == "list":
        after = o.get("tone") == "accent"
        col = P["ok"] if after else P["signal"]
        ob.box = rect(b, col, 1.6 * SW, P["panel"], 10)
        g.add(ob.box)
        g.add(Rectangle(width=ul(4), height=30 / H * FH, stroke_width=0, fill_color=col, fill_opacity=1).move_to(pt(b["x"] + 2, b["y"] + 29)))
        t = text_line((o.get("sub") or [""])[0], b["x"] + 24, b["y"] + 38, 24, col, o.get("subWidths", [0])[0], bold=True)
        if t: g.add(t)
        for i, line in enumerate(L):
            t = text_line(line, b["x"] + 24, baseline(b["y"] + 64, i, o["fontSize"]), o["fontSize"], P["ink"], w(i))
            if t: g.add(t)
        ob.outline = rect(b, P["accent"], 2.4 * SW, None, 15, 5)
    elif k == "metric":
        t = text_line(L[0] if L else "", b["x"], baseline(b["y"], 0, o["fontSize"]) - o["fontSize"] * 0.15, o["fontSize"], P["accent"], w(0), bold=True)
        if t: g.add(t)
    elif k == "meter":
        g.add(Rectangle(width=ul(b["w"]), height=b["h"] / H * FH, stroke_width=0, fill_color=P["hairline"], fill_opacity=1).move_to(pt(b["x"] + b["w"] / 2, b["y"] + b["h"] / 2)))
        ob.tracker = ValueTracker(float(o.get("value") or 0))
        def make_bar(tr=ob.tracker, b=b):
            v = max(0.0, min(1.0, tr.get_value()))
            wpx = max(0.5, b["w"] * v)
            return Rectangle(width=ul(wpx), height=b["h"] / H * FH, stroke_width=0, fill_color=P["accent"], fill_opacity=1 if v > 0.002 else 0).move_to(pt(b["x"] + wpx / 2, b["y"] + b["h"] / 2))
        ob.meter = make_bar()
        ob.meter.add_updater(lambda m, f=make_bar: m.become(f()))
        g.add(ob.meter)
    elif k == "code":
        lh = round(o["fontSize"] * 1.28)
        t = text_line((o.get("sub") or [""])[0], b["x"], b["y"] - 12, 15, P["inkSecondary"], o.get("subWidths", [0])[0], mono=True)
        if t: g.add(t)
        ob.box = rect(b, P["hairline"], 1.2 * SW, P["codeGround"], 8)
        g.add(ob.box)
        nums = o.get("numWidths", [])
        for i, line in enumerate(L):
            yb = baseline(b["y"] + 14, i, o["fontSize"])
            n = text_line(str(o.get("firstLine", 1) + i), b["x"] + 52, yb, o["fontSize"] - 2, P["inkSecondary"], nums[i] if i < len(nums) else 0, mono=True, anchor="end")
            if n: g.add(n)
            t = text_line(line, b["x"] + 68, yb, o["fontSize"], P["ink"], w(i), mono=True)
            if t: g.add(t)
    elif k == "source":
        d = Square(side_length=ul(7), stroke_width=0, fill_color=P["accent"], fill_opacity=1).rotate(PI / 4).move_to(pt(b["x"] + 5.5, b["y"] + 10.5))
        g.add(d)
        t = text_line(L[0] if L else "", b["x"] + 20, b["y"] + 15.5, o["fontSize"], P["inkSecondary"], w(0), mono=True)
        if t: g.add(t)
    else:
        col = P["inkSecondary"] if o.get("tone") == "secondary" else (P["accent"] if o.get("tone") == "accent" else P["ink"])
        for i, line in enumerate(L):
            t = text_line(line, b["x"], baseline(b["y"], i, o["fontSize"]), o["fontSize"], col, w(i))
            if t: g.add(t)
    return ob

class BrodyScene(MovingCameraScene):
    def setup(self):
        super().setup()
        self.camera.background_color = P["ground"]
        if not config.get("disable_caching", False):
            raise SystemExit("Refusing to render with caching on: a cache hit advances renderer.time by the nominal run time and the beats drift. Use --disable_caching.")
        self.overruns = []

    @property
    def elapsed(self):
        return float(getattr(self.renderer, "time", 0.0))

    def hold_until(self, t, key=""):
        gap = t - self.elapsed
        if gap > 1e-3:
            self.wait(gap)
        elif gap < -1.5 / config.frame_rate:
            self.overruns.append({"key": key, "late": round(-gap, 3)})
        return gap

    def construct(self):
        scene = MODEL["scene"]
        objs = {}
        order = sorted(scene["objects"], key=lambda o: o["z"])
        for o in order:
            objs[o["id"]] = build(o, scene)
        hud = [i for i, ob in objs.items() if ob.o["kind"] in ("kicker", "source")]
        rule = Line(pt(64, 90), pt(1216, 90), stroke_color=P["hairline"], stroke_width=1 * SW)
        self.add(rule)
        for o in order:
            ob = objs[o["id"]]
            if o["initial"].get("visible"):
                self.add(ob.group)
                if o["initial"].get("highlight") and ob.outline is not None:
                    self.add(ob.outline)
        self.states = {o["id"]: (o["initial"].get("state") or "idle") for o in order}
        self.scrim = None
        actions = sorted(scene["actions"], key=lambda a: a["startMs"])
        # Windows: actions that overlap in time are played together, each delayed by its own offset.
        windows = []
        for a in actions:
            s, e = a["startMs"] / 1000.0, (a["startMs"] + a["durationMs"]) / 1000.0
            if windows and s < windows[-1]["end"] - 1e-6:
                windows[-1]["acts"].append(a); windows[-1]["end"] = max(windows[-1]["end"], e)
            else:
                windows.append({"start": s, "end": e, "acts": [a]})
        for win in windows:
            self.hold_until(win["start"], win["acts"][0]["beatId"])
            t0 = max(win["start"], self.elapsed)
            anims, after = [], []
            for a in win["acts"]:
                offset = max(0.0, a["startMs"] / 1000.0 - t0)
                anims += self.animation_for(a, objs, hud, after, offset)
            # One flat play() call: a delayed member waits through its own rate function. Wrapping animations in
            # AnimationGroup or Succession would add a wrapper Group to the scene and redraw boxes over their labels.
            if anims:
                self.play(*anims)
            for f in after:
                f()
        self.hold_until(scene["frameCount"] / config.frame_rate, "end")
        with open(os.environ["BRODY_SCENE_REPORT"], "w") as fh:
            json.dump({"elapsed": self.elapsed, "overruns": self.overruns}, fh)

    def animation_for(self, a, objs, hud, after, offset):
        """The animations for one primitive, each lasting offset + duration, idle (rate 0) until its offset."""
        k = a["kind"]
        dur = max(1.0 / config.frame_rate, a["durationMs"] / 1000.0)
        tot = offset + dur
        f = offset / tot

        def rf(base=smooth):
            return lambda t: 0.0 if t <= f else base(min(1.0, (t - f) / max(1e-9, 1.0 - f)))

        ob = objs.get(a.get("target")) if a.get("target") else None
        if k == "appear" and ob:
            return [FadeIn(ob.group, shift=UP * ul(10), run_time=tot, rate_func=rf())]
        if k == "disappear" and ob:
            return [FadeOut(ob.group, run_time=tot, rate_func=rf())]
        if k == "draw" and ob:
            return [Create(ob.group, run_time=tot, rate_func=rf())]
        if k == "highlight" and ob and ob.outline is not None:
            return [FadeIn(ob.outline, run_time=tot, rate_func=rf())]
        if k == "unhighlight" and ob and ob.outline is not None:
            return [FadeOut(ob.outline, run_time=tot, rate_func=rf())]
        if k == "state" and ob and ob.box is not None:
            st = a.get("state") or "idle"
            col = state_color(st)
            self.states[ob.o["id"]] = st
            out = []
            if ob.o["kind"] == "cell":
                out.append(ob.box.animate(run_time=tot, rate_func=rf()).set_stroke(color=P["hairline"] if st == "idle" else col, width=(1.2 if st == "idle" else 1.8) * SW).set_fill(color=cell_fill(st), opacity=1.0))
                if ob.sub is not None:
                    out.append(ob.sub.animate(run_time=tot, rate_func=rf()).set_color(P["ok"] if st == "ok" else P["inkSecondary"]))
            else:
                out.append(ob.box.animate(run_time=tot, rate_func=rf()).set_stroke(color=col, width=(1.6 if st == "idle" else 2.2) * SW))
                if ob.glyph is not None:
                    out.append(ob.glyph.animate(run_time=tot, rate_func=rf()).set_stroke(color=P["inkSecondary"] if st == "idle" else col))
            return out
        if k == "value" and ob and ob.tracker is not None:
            return [ob.tracker.animate(run_time=tot, rate_func=rf()).set_value(float(a.get("value", 0)))]
        if k == "label" and ob and ob.o["kind"] == "cell":
            b = ob.o["box"]
            new = text_line(a.get("text", ""), b["x"] + 9, b["y"] + 41, 16, P["ok"] if a.get("text") == "free" else P["inkSecondary"], a.get("textWidth", 0))
            old = ob.sub
            ob.sub = new
            out = []
            if old is not None:
                out.append(FadeOut(old, run_time=tot, rate_func=rf()))
                after.append(lambda g=ob.group, m=old: g.remove(m))
            if new is not None:
                ob.group.add(new)
                out.append(FadeIn(new, run_time=tot, rate_func=rf()))
            return out
        if k == "flow" and ob and ob.path is not None:
            path = ob.path
            length = max(1e-6, sum(np.linalg.norm(path.points[i + 1] - path.points[i]) for i in range(0, len(path.points) - 1)))
            speed = ul(240)
            dots = [Dot(radius=ul(4.5), color=P["accent"], fill_opacity=0.0) for _ in range(2)]
            def mover(m, alpha, off):
                if alpha <= 0.0:
                    m.set_fill(opacity=0.0)
                    return
                m.set_fill(opacity=1.0)
                frac = ((alpha * dur * speed / length) + off) % 1.0
                m.move_to(path.point_from_proportion(frac))
            for d in dots:
                self.add(d)
            after.append(lambda ds=dots: self.remove(*ds))
            return [UpdateFromAlphaFunc(d, lambda m, al, off=i * 0.5: mover(m, al, off), run_time=tot, rate_func=rf(linear)) for i, d in enumerate(dots)]
        if k == "scrim":
            r = a.get("view") or {"x": -10, "y": -10, "w": 1300, "h": 740}
            self.scrim = Rectangle(width=ul(r["w"] + 12), height=ul(r["h"] + 12), stroke_width=0, fill_color=P["scrim"], fill_opacity=0.0).move_to(pt(r["x"] + r["w"] / 2, r["y"] + r["h"] / 2))
            self.add(self.scrim)
            # Only objects already on screen are raised above the scrim: bring_to_front() would ADD anything else,
            # and every source marker of the scene would appear at once.
            on_screen = set(id(m) for m in self.mobjects)
            keep = [objs[i].group for i in a.get("keep", []) if i in objs] + [objs[i].group for i in hud]
            keep = [m for m in keep if id(m) in on_screen]
            if keep:
                self.bring_to_front(*keep)
            return [self.scrim.animate(run_time=tot, rate_func=rf()).set_fill(opacity=0.8)]
        if k == "unscrim" and self.scrim is not None:
            s = self.scrim
            self.scrim = None
            after.append(lambda: self.remove(s))
            return [s.animate(run_time=tot, rate_func=rf()).set_fill(opacity=0.0)]
        if k == "camera" and a.get("view"):
            v = a["view"]
            return [self.camera.frame.animate(run_time=tot, rate_func=rf()).move_to(pt(v["x"] + v["w"] / 2, v["y"] + v["h"] / 2)).set(width=ul(v["w"]))]
        if k == "lines" and ob and a.get("range") and ob.o["kind"] == "code":
            b = ob.o["box"]
            lh = round(ob.o["fontSize"] * 1.28)
            first = ob.o.get("firstLine", 1)
            lo = max(0, a["range"][0] - first)
            hi = min(len(ob.o["lines"]) - 1, a["range"][1] - first)
            if hi < lo:
                return []
            top = b["y"] + 14 + lo * lh - 2
            h = (hi - lo + 1) * lh + 2
            band = Rectangle(width=ul(b["w"] - 4), height=ul(h), stroke_width=0, fill_color=P["codeHighlight"], fill_opacity=1).move_to(pt(b["x"] + b["w"] / 2, top + h / 2))
            bar = Rectangle(width=ul(3), height=ul(h), stroke_width=0, fill_color=P["accent"], fill_opacity=1).move_to(pt(b["x"] + 3.5, top + h / 2))
            # The band sits above the code panel and below the code text.
            rest = [m for m in ob.group.submobjects if m is not ob.box]
            self.remove(ob.group)
            self.add(ob.box, band, bar, *rest)
            return [FadeIn(band, run_time=tot, rate_func=rf()), FadeIn(bar, run_time=tot, rate_func=rf())]
        return []
`;
