import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { languageByCode } from "@/lib/languages";

const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const MAX_BODY_BYTES = MAX_AUDIO_BYTES + 16 * 1024;
const AUDIO_TYPES = new Set(["audio/webm", "audio/mp4"]);

function error(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return error("Unauthorized. Sign in to transcribe audio.", 401);
  const key = process.env.OPENAI_API_KEY;
  if (!key) return error("Audio transcription is not configured (OPENAI_API_KEY).", 503);
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data;")) {
    return error("Expected multipart audio upload.", 400);
  }
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) return error("Audio upload is too large (maximum 2 MiB).", 413);

  // Bound the actual body too: content-length may be absent or untrusted.
  let form: FormData;
  const reader = request.body?.getReader();
  if (!reader) return error("Audio upload is required.", 400);
  try {
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel();
        return error("Audio upload is too large (maximum 2 MiB).", 413);
      }
      chunks.push(value);
    }
    form = await new Response(new Blob(chunks), {
      headers: { "Content-Type": request.headers.get("content-type")! },
    }).formData();
  } catch {
    return error("Invalid multipart audio upload.", 400);
  } finally {
    reader.releaseLock();
  }

  const file = form.get("file");
  const language = form.get("language");
  if (!(file instanceof File) || file.size === 0) return error("A nonempty audio file is required.", 400);
  if (file.size > MAX_AUDIO_BYTES) return error("Audio file is too large (maximum 2 MiB).", 413);
  const mime = file.type.split(";")[0].trim().toLowerCase();
  if (!AUDIO_TYPES.has(mime)) return error("Unsupported audio format. Use MP4 or WebM audio.", 415);
  if (typeof language !== "string" || !languageByCode(language)) return error("Unsupported transcription language.", 400);

  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const webm = header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3;
  const mp4 = header[4] === 0x66 && header[5] === 0x74 && header[6] === 0x79 && header[7] === 0x70;
  if (!(mime === "audio/webm" ? webm : mp4)) return error("Invalid audio container. Record a new segment.", 400);

  const upload = new FormData();
  upload.append("file", file, mime === "audio/mp4" ? "segment.mp4" : "segment.webm");
  upload.append("model", "gpt-4o-mini-transcribe");
  upload.append("language", language);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  request.signal.addEventListener("abort", cancel, { once: true });
  if (request.signal.aborted) cancel();
  const timeout = setTimeout(cancel, 25000);
  try {
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST", headers: { Authorization: `Bearer ${key}` },
      body: upload, signal: controller.signal, cache: "no-store",
    });
    if (!response.ok) {
      if (response.status === 429) return error("Transcription capacity or billing quota exceeded. Check OpenAI billing or try later.", 429);
      if (response.status === 401 || response.status === 403) return error("Transcription service credentials are not accepted. Contact the administrator.", 503);
      if (response.status === 400) return error("The transcription service could not decode this audio. Start listening again.", 422);
      return error("The transcription service is unavailable. Try again later.", 502);
    }
    const payload = await response.json();
    if (typeof payload?.text !== "string") return error("Invalid response from the transcription service.", 502);
    return NextResponse.json({ text: payload.text.trim() }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return error(controller.signal.aborted ? "Audio transcription was cancelled or timed out. Try again." : "Could not reach the transcription service. Try again.", 502);
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", cancel);
  }
}
