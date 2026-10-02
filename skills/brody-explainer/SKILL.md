---
name: brody-explainer
description: Turn a grounded Brody result (an Ask Repository answer, a file, area, folder or whole-system explanation, or a review finding) into a clear explanation, a diagram, an interactive explainer or a narrated, animated video with captions and sources. Use when the user wants something explained visually, taught, animated, or "shown how it works", and the material is already in Brody.
---

# Brody explainer

Brody turns a result it has already produced and verified into an explanation artifact. It never researches again and
never takes the explanation's facts from you: you name the result, Brody reads its stored, cited state.

## Name the result

Every Brody result has a `sourceRunId`:

| Result | sourceRunId |
| --- | --- |
| An Ask Repository answer | `question:<id>` (the `id` returned by `POST /api/projects/:id/ask`) |
| A file explanation | `file:<path>` |
| A functional area | `area:<id>` |
| A folder | `module:<path>` |
| A review finding | `finding:<code>` (for example `finding:SEC-004`) |
| The whole system | `system` |

## Use the tools

Over MCP (`npm run explainer:mcp`, or `claude mcp add brody-explainer -- npm --prefix <brody> run -s explainer:mcp`),
or over HTTP with `POST /api/explainer/tool {"name", "arguments"}`:

1. `create_explainer {projectId, sourceRunId, mode?, duration?, audience?}`. `mode` is `text`, `diagram`,
   `interactive`, `video` or `auto` (Brody's recommendation). Text and diagram return at once. Interactive and video start a
   background job and return its `jobId`.
2. `get_video_job {jobId}`. Poll every 10 to 20 seconds. Artifacts arrive in order: `plan`, then `transcript`, `audio`
   and `captionsVtt`, then `storyboard` and `scenePlan` (the interactive explainer can play now), then `video`.
3. `refine_explainer {explanationId, request}`. Plain words: "make this shorter", "explain it for a beginner",
   "redo just the final section and show how X fixes this". Only affected sections are regenerated.
4. `regenerate_section {jobId, sectionId, instruction?}`. One section, with or without new direction.

## Rules

- Do not paste the answer text into a tool; pass the `sourceRunId`.
- Cloud voices may receive narration only when the user's privacy setting allows it. Do not set `allowExternal`
  unless the user asked for a cloud voice for this video.
- A failed video never invalidates the result: offer the text, diagram and transcript, and retry the job
  (`POST /api/video-jobs/:id/retry`, finished stages are reused).
- Report the validation outcome (`job.validation`) rather than assuming a finished render is correct.
