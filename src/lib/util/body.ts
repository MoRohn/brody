import { AppError } from "./errors";

/**
 * Read a multipart upload with a hard cap on the bytes actually received. The Content-Length header is only a hint: a
 * chunked request has none and a hostile client can state any number, so trusting it (as `req.formData()` does) lets a
 * request buffer far more than the limit before anything checks its size. This counts the real stream, stops reading and
 * drops the connection the moment the cap is passed, and only then parses the form.
 */
export async function readCappedForm(req: Request, maxBytes: number, what: string): Promise<FormData> {
  const limitMb = Math.round(maxBytes / 1024 / 1024);
  const tooLarge = (declaredBytes?: number) => new AppError("upload_too_large", `${what} is ${declaredBytes ? `${Math.round(declaredBytes / 1024 / 1024)} MB, over` : "larger than"} the ${limitMb} MB limit.`, 413, "Exclude large or generated folders, upload a smaller project, or raise MAX_UPLOAD_BYTES.");
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared >= maxBytes) throw tooLarge(declared);
  const type = req.headers.get("content-type") ?? "";
  if (!req.body) throw new AppError("invalid_upload", `${what} could not be read as a multipart form.`, 400, "Send the files as multipart/form-data.");

  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = req.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      // Reaching the cap is treated as too large: the framework in front of this route cuts a body off at exactly this size, so a
      // stream that ends here was truncated, and its form would only fail to parse with a confusing message.
      if (received >= maxBytes) { await reader.cancel().catch(() => undefined); throw tooLarge(); }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  try {
    return await new Response(new Blob(chunks as BlobPart[]), { headers: { "content-type": type } }).formData();
  } catch {
    throw new AppError("invalid_upload", `${what} could not be read as a multipart form.`, 400, "Try again, or upload the project as a ZIP archive.");
  }
}
