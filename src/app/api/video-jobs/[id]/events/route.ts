import { fail } from "@/lib/api";
import { getJobView } from "@/lib/explainer";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/video-jobs/:id/events  Server-sent events: one "job" event whenever the job changes (stage, progress, a new
 * artifact), and a final "end" event when it is ready, failed or cancelled. The job row is the source of truth, so the
 * stream works across processes (a separate worker writes, the web server streams).
 */
export async function GET(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    getJobView(id);
    const enc = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let last = "";
        let idle = 0;
        const send = (event: string, data: unknown) => controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        const tick = () => {
          try {
            const job = getJobView(id);
            const key = JSON.stringify([job.status, job.currentStage, job.progress, Object.keys(job.artifacts).length, job.stages.map((s) => s.status)]);
            if (key !== last) { last = key; idle = 0; send("job", job); }
            else if (++idle % 30 === 0) controller.enqueue(enc.encode(": keep-alive\n\n"));
            if (job.status === "ready" || job.status === "failed" || job.status === "cancelled") { send("end", { status: job.status }); clearInterval(timer); controller.close(); }
          } catch (e) {
            clearInterval(timer);
            send("error", { message: (e as Error).message });
            controller.close();
          }
        };
        tick();
        timer = setInterval(tick, 500);
        req.signal.addEventListener("abort", () => { clearInterval(timer); try { controller.close(); } catch { /* already closed */ } });
      },
      cancel() { clearInterval(timer); },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
  } catch (e) {
    return fail(e);
  }
}
