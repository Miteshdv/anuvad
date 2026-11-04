import { NextResponse } from "next/server";
import { Resend } from "resend";
import { auth } from "@/lib/auth";

type Turn = {
  speaker?: string;
  source: string;
  sourceLang: string;
  target: string;
  targetLang: string;
};

type Body = { turns?: Turn[] };

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function POST(request: Request) {
  const session = await auth();
  const email = session?.user?.email;
  if (!session?.user?.id || !email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const key = process.env.RESEND_API_KEY;
  if (!key) {
    return NextResponse.json({ error: "RESEND_API_KEY is not configured" }, { status: 503 });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const turns = (body.turns ?? []).filter(
    (t) =>
      typeof t?.source === "string" &&
      typeof t?.target === "string" &&
      typeof t?.sourceLang === "string" &&
      typeof t?.targetLang === "string",
  );

  if (turns.length === 0) {
    return NextResponse.json({ error: "No transcript to send" }, { status: 400 });
  }
  if (turns.length > 200) {
    return NextResponse.json({ error: "Transcript too long" }, { status: 400 });
  }

  const rows = turns
    .map(
      (t) => `<tr>
        <td style="padding:8px;border-bottom:1px solid #eee;color:#666;white-space:nowrap">${escapeHtml(
          t.speaker?.trim() ? t.speaker.trim() : "—",
        )}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;color:#666;white-space:nowrap">${escapeHtml(t.sourceLang)}</td>
        <td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(t.source)}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;color:#666;white-space:nowrap">${escapeHtml(t.targetLang)}</td>
        <td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml(t.target)}</td>
      </tr>`,
    )
    .join("\n");

  const html = `<div style="font-family:system-ui,sans-serif">
    <h2 style="margin:0 0 4px">Your Anuvad transcript</h2>
    <p style="margin:0 0 16px;color:#666">${turns.length} turn${turns.length === 1 ? "" : "s"} · ${new Date().toUTCString()}</p>
    <table style="border-collapse:collapse;width:100%;font-size:14px">
      <thead>
        <tr>
          <th style="text-align:left;padding:8px;border-bottom:2px solid #ddd">Speaker</th>
          <th style="text-align:left;padding:8px;border-bottom:2px solid #ddd">From</th>
          <th style="text-align:left;padding:8px;border-bottom:2px solid #ddd">Original</th>
          <th style="text-align:left;padding:8px;border-bottom:2px solid #ddd">To</th>
          <th style="text-align:left;padding:8px;border-bottom:2px solid #ddd">Translation</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;

  const resend = new Resend(key);
  const from = process.env.TRANSCRIPT_FROM ?? "onboarding@resend.dev";

  try {
    const { error } = await resend.emails.send({
      from: `Anuvad <${from}>`,
      to: email,
      subject: `Anuvad transcript — ${new Date().toLocaleDateString("en-GB")}`,
      html,
    });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    return NextResponse.json({ ok: true, sentTo: email, count: turns.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to send email";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
