import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { languageByCode } from "@/lib/languages";

const DEFAULT_VOICES: Record<string, string> = {
  en: "alloy",
  hi: "alloy",
  es: "alloy",
  fr: "alloy",
  de: "alloy",
  pt: "alloy",
  ja: "alloy",
  ko: "alloy",
  zh: "alloy",
  ar: "alloy",
};

const GENDER_VOICES = { female: "shimmer", male: "onyx" } as const;

type Body = { text?: string; lang?: string; gender?: "default" | "female" | "male" };

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return NextResponse.json({ error: "OPENAI_API_KEY is not configured" }, { status: 503 });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const text = body.text?.trim();
  const lang = body.lang ?? "";
  if (!text) {
    return NextResponse.json({ error: "`text` is required" }, { status: 400 });
  }
  if (!languageByCode(lang)) {
    return NextResponse.json({ error: "Unsupported language" }, { status: 400 });
  }
  if (text.length > 2000) {
    return NextResponse.json({ error: "`text` exceeds 2000 characters" }, { status: 400 });
  }
  const gender = body.gender ?? "default";
  if (!(["default", "female", "male"] as const).includes(gender)) {
    return NextResponse.json({ error: "Unsupported voice gender" }, { status: 400 });
  }

  try {
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice: gender === "default" ? DEFAULT_VOICES[lang] ?? "alloy" : GENDER_VOICES[gender],
        input: text,
        response_format: "mp3",
        instructions: `Speak clearly and naturally in ${languageByCode(lang)!.label}.`,
      }),
      cache: "no-store",
    });

    if (!res.ok) {
      const detail = await res.text();
      return NextResponse.json(
        { error: `OpenAI TTS error ${res.status}`, detail: detail.slice(0, 500) },
        { status: 502 },
      );
    }

    return new NextResponse(res.body, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "TTS failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
