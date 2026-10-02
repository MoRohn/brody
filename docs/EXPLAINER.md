# Explainers: from a grounded result to understanding

Brody's results are verified and cited, but a paragraph is not always the best way to understand a system. Any Brody
result can become a **clear explanation**, a **diagram**, an **interactive explainer** or a **narrated, animated video**,
all rendered from one canonical representation of what needs explaining, so the formats can never drift apart.

```
Brody result (Ask answer · file / area / folder / system explanation · finding)
      │  stored, verified, cited
      ▼
UNDERSTANDING COMPILER ─────────► ExplanationArtifactSpec (the Explanation IR)
      │                                 │
      │      ┌──────────────┬───────────┼──────────────┬────────────────────┐
      ▼      ▼              ▼           ▼              ▼                    ▼
 Mode router  Clear text    Diagram     Narration plan → TTS (measured word timing) → beats → scene plan
                                                                                        │
                                                         Interactive player ◄───────────┤
                                                         Manim / HTML renderers ─► MP4 + captions + transcript
```

The principle that makes the video work is from [explainer-video](https://github.com/PaulLemaistre/explainer-video)
(MIT, see `THIRD_PARTY_NOTICES.md`): **animation is cut to measured word timings, never to a guessed speaking rate.**

## Using it

* **Ask Repository**: every answer has **Explain ▾**, with *Clear explanation*, *Diagram*, *Interactive* and *Video*.
* **System Explanation**: the same control on the whole system, every functional area, folder and file.
* **Explainers** (project navigation): every explanation of the project, and **Voice & privacy** settings.

The panel shows Brody's recommendation (*Recommended: Text · Diagram · Video*, a video-value score and its reasons) and
how grounded the explanation is. Video runs in the background; the answer and the other formats stay usable. Progress
streams as it happens: *Planning explanation → Writing narration → Generating voice → Designing scenes → Rendering →
Finalizing*, with the plan, transcript, audio and storyboard appearing before the video. The interactive explainer plays
as soon as the storyboard exists.

A finished video has captions (from the measured timings), chapters, a transcript that seeks the video and follows it,
the sources of the sentence being spoken, speed, fullscreen and downloads (MP4, WebVTT, SRT, transcript, narration WAV,
manifest). Changes are made in plain words (**Apply**: "make this shorter", "explain it for a beginner", "focus more on
the scheduler", "remove the intro", "make the visuals less animated", "use a local voice", "redo just the final section
and show how dynamic GPU scheduling fixes this"), by editing the narration of any section, or with ⟳ on a chapter.
Each change regenerates only what it touches.

## The Explanation IR (`src/lib/explainer/types.ts`)

`ExplanationArtifactSpec` holds concepts (with a glyph, containment and instance counts: *8 GPUs inside a DGX*),
claims, evidence, sources (file and lines, with the cited snippet), relationships, processes, metrics, comparisons,
examples, uncertainties, the narrative (hook, sections, conclusion), visualization hints, provenance and a confidence.

**Compilation** (`compile.ts`) never researches again. It reads the stored result and the lines it cites:

1. A deterministic pass always produces a complete spec: every sentence of the result becomes a claim linked to the
   sources it names, plus concepts, relationships, metrics and a problem/fix narrative found in those claims.
2. With an AI provider, two structured calls reorganise the same material: first the parts (restated claims, concepts,
   relationships, metrics), then the story (sections, comparisons, processes, hook, conclusion). Two calls, because one
   combined schema compiles to a grammar some providers refuse; enumerations are plain strings coerced in code, because
   providers do not always enforce them.
3. **The grounding guard** (`grounding.ts`) checks everything the model wrote: a restated claim must rest on supported
   claims or sources and may not introduce a number, identifier, quoted string or proper name the grounded material
   lacks. Counts and metrics must be stated. What fails is kept as an *unsupported* claim (visible in Artifacts) that no
   renderer will speak or draw.

`validateSpec` (`spec.ts`) checks referential integrity: section → claim → evidence → source, concept → parent,
relationship → concepts, and that nothing shown rests on an unsupported claim.

## Mode router (`router.ts`)

Scores come from the spec, not the prose: interacting components, process steps, time-dependent and contention language,
containment, before/after contrasts, metrics and code. Video is recommended when animation adds understanding a static
diagram cannot (change over time, resources contended for or left idle, a before/after) and the result is not trivial;
it stays available on request for every result. The router also suggests a length: **quick** (30–60 s), **standard**
(1–3 min) or **deep** (3–10 min). Length is enforced on **measured** speech: after synthesis, a narration outside its
window is shortened or extended section by section and only those sections are re-spoken.

## Narration (`narrate.ts`, `speech.ts`)

Written for the ear: short sentences, active verbs, terms defined before use (always, for beginners), no spoken
headings, no filler: about 80% controlled technical English (ASD-STE100-inspired word list and sentence rules, applied
mechanically by `controlNarration`) and 20% natural connection. Every sentence passes the grounding guard; a rejected
sentence is recorded in `plan.rejected`. Section ids are stable (`hook`, the spec's section ids, `outro`), so a revised
plan leaves untouched sections byte-identical and their audio and scenes are reused.

Each sentence has a **display** form (captions, transcript) and a **spoken** form for the voice: `nvidia.com/gpu` is
spoken "nvidia dot com slash G P U", `requestCancel()` "request cancel", `80GB` "80 gigabytes", `v1.2.3` "version 1 point
2 point 3", URLs by host and path, operators by name. Each display token remembers the spoken words it became.

## Voices and timing (`tts/`, `timing.ts`, `beats.ts`)

| Provider | Runs | Timing |
| --- | --- | --- |
| macOS on-device (`macos`) | local, no key | **measured** by the speech engine: samples written before each word callback (verified against the audio's silences: within ~20 ms) |
| Piper (`piper`) | local | **sentence-level, measured**: each sentence synthesised alone and its samples counted; words inside a sentence are interpolated and flagged; beats snap to sentence starts |
| ElevenLabs | cloud | measured, from the service's character alignment |
| Speechify | cloud | measured, from speech marks |
| OpenAI | cloud | **aligned**: speech, then OpenAI transcription with word timestamps on that audio |
| synthetic | local | a deterministic test voice (tests and CI only; never chosen automatically) |

Capabilities (`supportsWordTimings`, `supportsSentenceTimings`, `supportsStreaming`, `supportsLocalInference`,
`supportsVoiceClone`) are declared per provider. Routing (`tts/index.ts`) honours the execution mode — **local**
(nothing leaves the machine), **hybrid** (local first) or **cloud** — and the privacy policy: **local-only**, **ask**
(default: a per-video checkbox) or **allow**. Narration is classified first (`privacy.ts`): secrets are redacted always
and make the text ineligible for any external provider; code from uploads or private imports is confidential. A failing
voice is retried once on a retryable error, then the next eligible voice speaks every section (one voice per video).

Measured words are mapped back onto display tokens (`timing.ts`): by character range when the provider reports it,
otherwise by character alignment (LCS) of the transcribed words. Anything not measured is interpolated between measured
neighbours and counted; timestamps are non-negative, increasing and inside the audio. Every section is padded to a
whole number of video frames (`audio.ts`), so a section spoken again can never shift the frame grid of the others.

**Beats** are semantic visual events (introduce, highlight, connect, show data flow, set state, emphasise a metric,
transform, compare, zoom, dim context, show code, reveal the result) anchored to the opening words of a sentence. Cues
are matched against the measured words in spoken order (a phrase spoken twice lands on the right occurrence); a cue
that is not found falls back to its best sentence and says so. Beat times are rounded relative to their section, so a
section's beats do not depend on where it falls in the video.

## Scenes and rendering (`scenes.ts`, `frame.ts`, `render/`)

The **visual scene planner** is the deterministic boundary between reasoning and rendering. It lays out every object on
a 1280×720 grid with text pre-wrapped using the renderers' own fonts (`measure.ts`, DejaVu via fontkit), turns beats into
primitives in scene-local milliseconds (appear, draw, highlight, state, value, label, flow, scrim, camera, lines), and
carries each diagram scene's closing state (who holds which GPU, what is blocked) into the next as its opening state.
Diagrams use one geometry for the whole video. Containment and instances are drawn as groups and cells; who holds
which instance is shown on the cells ("pod 3"), not with a tangle of lines; connectors route around boxes.

Renderers only draw:

* **HTML renderer**: `frame.ts` renders a scene at time *t* to SVG; resvg rasterises it with the same font files and
  frames stream into FFmpeg. The interactive player in the browser runs the **same** frame function, driven by the
  narration's clock, so the interactive explainer and the video cannot disagree.
* **Manim renderer**: a generic interpreter (`render/manim-script.ts`) draws the same scene JSON with Manim's own
  animations. It keeps the reference's safeguards: beats are held with `hold_until()` against `self.renderer.time`, the
  real clock; the script refuses to run without `--disable_caching`; dimming is a scrim, never `set_opacity()`; outline
  shapes carry an invisible ground-coloured fill; highlights are outlines, never `Indicate()`; text is built four times
  larger and scaled to its measured size; values change through a `ValueTracker` and `become()`. All animations of a
  window are played in one flat `play()` call with delays in their rate functions: wrapping them in `AnimationGroup` or
  `Succession` makes Manim add a wrapper group on top of the scene and redraw boxes over their labels.

Renderers are chosen **per scene**: Manim for architecture, contention, process, comparison and equations; HTML for
statements, metrics, code and timelines; HTML for everything when Manim is missing. Every scene is conformed to exactly
its frame count (`conformScene`: pad by cloning the last frame, or cut) and the scenes are concatenated without
re-encoding, then muxed with the narration. A renderer that fails on a scene falls back to the HTML renderer for that
scene. New engines (Remotion, Three.js, WebGL) implement `ExplainerRenderer` (`render/types.ts`).

**Design system** (`design.ts`): an instrument panel, not a slide deck. Deep navy ground, one ink, one cerulean accent
for the single thing being discussed, a signal colour for trouble and a green for the healthy state; DejaVu Sans
Condensed and Mono; a 1280×720 grid whose bottom band stays free for captions; motion only when it means something.
Every text colour is checked against its ground in three styles (`brody`, `brody-light`, `calm`).

## Jobs (`pipeline.ts`)

`QUEUED → PLANNING → SCRIPTING → TTS → ALIGNING → STORYBOARDING → RENDERING → MUXING → VALIDATING → READY` (or
`FAILED` / `CANCELLED`), persisted in `video_jobs` and run by the same worker process as analysis, in its own loop.

* **Content-addressed stages.** Section audio is keyed by its spoken text, voice, provider and pause; scene videos by
  the scene's full hash (objects, actions, timing, frame count) plus the renderer and its version. A cached render is
  reused only on an exact match, so caching can never reintroduce drift.
* **Retry, resume, cancel, timeout.** Retry and stale-worker recovery requeue the job; finished stages come from the
  cache. Cancellation is checked between units of work and aborts running subprocesses. Jobs have a time limit.
* **Section-level work.** A refinement, a narration edit or ⟳ on a chapter re-plans only those sections; unchanged
  sections reuse their audio and scenes.
* **Graceful failure.** A failure keeps every artifact produced before it and never touches the result being explained.
* **Manifest.** Each job writes `manifest.json`: spec, plan, audio and section audio, word timings, beats, scene plan,
  renderer sources, scene videos, captions, transcript, video, thumbnail, storyboard, duration, renderers, voice, timing
  source and granularity, model versions, source references, stage hashes, validation, and metrics per stage (time,
  in-process CPU, reuse, cost, tokens), total cost and artifact size.

## Validation (`validate.ts`)

Before rendering: text fits its boxes (measured), objects stay in frame and out of the caption band, text is at least
16 px, nothing overlaps while both are on screen, scenes are not overcrowded or empty, colours meet their contrast floor.
A failing scene is simplified and checked again. After rendering: audio exists and is audible, the video exists,
decodes end to end, has the planned resolution, frame rate and every planned frame, audio and video agree within a
frame, the duration equals the measured narration, no scene midpoint is a blank frame, captions are valid WebVTT, cover
every word and match the narration word for word, timestamps are non-negative, monotonic and non-empty, every section
has beats, every beat's claims resolve to sources, and every factual sentence carries sources. Empty scenes are
re-rendered once with the HTML renderer. A job is READY only if nothing fails.

## API

| Method | Path | |
| --- | --- | --- |
| POST | `/api/explanations` | `{projectId, source, audience?, intent?, reuse?}` compile a result (source: `{kind:"question",id}`, `{kind:"file",path}`, `{kind:"area",id}`, `{kind:"module",path}`, `{kind:"finding",code}`, `{kind:"system"}`) |
| GET | `/api/explanations?projectId=` | list |
| GET / PATCH | `/api/explanations/:id` | spec, recommendation, clear text, diagram, jobs / `{audience}` |
| POST | `/api/explanations/:id/video` | `{duration?, audience?, style?, renderer?, execution?, ttsProvider?, voice?, allowExternal?, motion?}` |
| POST | `/api/explanations/:id/refine` | `{request}` → what was understood, and the job |
| PUT | `/api/explanations/:id/narration` | `{narration: {sectionId: text}}` |
| GET | `/api/explanations/:id/files/<path>` | artifacts, with HTTP ranges; `?download=1` |
| GET | `/api/video-jobs/:id` | status, stages, progress, artifacts, validation, metrics |
| GET | `/api/video-jobs/:id/events` | server-sent events (`job`, `end`) |
| POST | `/api/video-jobs/:id/cancel`, `/retry`, `/regenerate-section` | `{sectionId, instruction?}` for the last |
| GET / PUT | `/api/explainer/settings` | routing, privacy, voices and renderers with availability |
| GET / POST | `/api/explainer/tool` | tool definitions / `{name, arguments}` |

State-changing requests must be JSON, so a cross-site page cannot start jobs.

## Agents, MCP and skills

`tool.ts` defines `create_explainer`, `get_video_job`, `refine_explainer` and `regenerate_section`, shared by the HTTP
tool endpoint, the MCP server (`npm run explainer:mcp`, stdio, forwarding to a running Brody at `BRODY_URL`) and the
skill in `skills/brody-explainer/SKILL.md`. Tools take a `sourceRunId`, never the answer text, so an agent cannot
restate, embellish or inject the material being explained.

## Setup

FFmpeg is required. `npm run explainer:setup` checks it and installs Manim into a private virtualenv when cairo and
pango are present; without Manim every scene uses the HTML renderer. macOS has an on-device voice; on Linux set
`PIPER_MODEL` for Piper, or configure a cloud voice. The Docker image includes FFmpeg; build with
`--build-arg WITH_MANIM=1` for Manim. All settings are in `.env.example`.

## Tests

`tests/explainer-acceptance.test.ts` runs the full acceptance scenario (the GPU-scheduling question on
`fixtures/dgx-ai-platform`, including a planted ungrounded claim and sentence, and a single-section regeneration).
`tests/explainer-units.test.ts` covers speech, timing, beats, captions, grounding, the router, spec validation, AI
structure verification, refinement rules, WAV handling, providers, privacy and contrast. `tests/explainer-jobs.test.ts`
covers job lifecycle, cancellation, retry and resume, voice fallback and timeouts, renderer crashes, missing FFmpeg,
local-only and privacy routing, sentence-timed voices, stale-worker recovery and the HTTP API.
`tests/explainer-render.test.ts` covers layout validation, the frame function, the HTML renderer, media validation of
broken output, the Manim safeguards (caching refused, no frame drift across forty odd-length animations, pixel agreement
with the SVG renderer) and the macOS voice's timing against the audio. Manim and macOS tests are skipped where those
are not installed.

## Known limitations

* The macOS voice is the only keyless voice with measured word timing; Piper gives sentence-level timing only. Cloud
  voices need keys and, for repository content, permission.
* There is no visual-critic model: Brody's AI interface is text-only, so visual quality is checked by measurement
  (layout, contrast, blank frames, Manim/SVG agreement in tests), not by a model looking at frames.
* Diagram layout is a layered placement for up to twelve concepts; larger structures drop the least important concepts
  and say so.
* CPU and GPU metrics cover in-process work; subprocess renders record wall time. Rendering runs on the CPU.
* Explanations are not included in Brody bundles; reopen a bundle and use Explain again.
