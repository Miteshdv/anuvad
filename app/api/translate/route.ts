import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { translateText } from "@/lib/translate";
import { checkAndIncrementUsage } from "@/lib/rate-limit";
import { languageByCode } from "@/lib/languages";

type Body = { text?: string; from?: string; to?: string };

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const text = body.text?.trim();
  const from = body.from ?? "";
  const to = body.to ?? "";

  if (!text) {
    return NextResponse.json({ error: "`text` is required" }, { status: 400 });
  }
  if (text.length > 5000) {
    return NextResponse.json({ error: "`text` exceeds 5000 characters" }, { status: 400 });
  }
  if (!languageByCode(to)) {
    return NextResponse.json({ error: "Unsupported target language" }, { status: 400 });
  }
  if (from && from !== "auto" && !languageByCode(from)) {
    return NextResponse.json({ error: "Unsupported source language" }, { status: 400 });
  }

  const usage = await checkAndIncrementUsage(session.user.id);
  if (!usage.allowed) {
    return NextResponse.json(
      { error: "Daily translation limit reached", limit: usage.limit, used: usage.used },
      { status: 429 },
    );
  }

  try {
    const { translated, detectedSource } = await translateText(text, from, to);
    return NextResponse.json({ translated, detectedSource, used: usage.used, limit: usage.limit });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Translation failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
