// Google Cloud Translation v2 REST endpoint — one fetch, no SDK.
// The gRPC-based @google-cloud/translate package is flaky on Vercel serverless.

type TranslateResponse = {
  data?: {
    translations?: {
      translatedText?: string;
      detectedSourceLanguage?: string;
    }[];
  };
  error?: { message?: string };
};

export async function translateText(
  text: string,
  from: string,
  to: string,
): Promise<{ translated: string; detectedSource?: string }> {
  const key = process.env.GOOGLE_TRANSLATE_API_KEY;
  if (!key) throw new Error("GOOGLE_TRANSLATE_API_KEY is not set");

  const params = new URLSearchParams({
    key,
    q: text,
    target: to,
    format: "text",
  });
  if (from && from !== "auto") params.set("source", from);

  const res = await fetch("https://translation.googleapis.com/language/translate/v2", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    cache: "no-store",
  });

  const json = (await res.json()) as TranslateResponse;
  if (!res.ok || json.error) {
    throw new Error(json.error?.message ?? `Translate API error ${res.status}`);
  }

  const t = json.data?.translations?.[0];
  if (!t?.translatedText) throw new Error("Translate API returned no translation");

  return { translated: t.translatedText, detectedSource: t.detectedSourceLanguage };
}
