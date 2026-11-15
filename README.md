# Anuvad

Browser-based speech translation. Start listening, speak naturally, and see speech transcribed in the source pane. Review or edit the text, click **Translate**, and click **Replay latest** to hear the result. Typing and speech never trigger translation or playback automatically. Choose the translated voice, play speech, and email yourself the transcript.

## Stack

| Concern | Choice |
| --- | --- |
| Framework | Next.js 16 (App Router, Cache Components) |
| Auth | Auth.js v5 with Google provider, database sessions |
| Database | Neon Postgres via Prisma 7 (`@prisma/adapter-pg`) |
| Translation | Google Cloud Translation v2 REST |
| Text-to-speech | OpenAI `gpt-4o-mini-tts` |
| Email | Resend |
| Speech input | AudioWorklet PCM/WAV microphone capture + OpenAI `gpt-4o-mini-transcribe` |

## Features

- Google sign-in; `/translate` is protected by `proxy.ts`.
- Ten source/target languages with a swap control.
- Click-to-toggle microphone recording with ordered short-segment transcription; translation runs only on clicking **Translate**.
- Side-by-side editable source and translated text panes, with manual playback.
- Selectable default, female-sounding, or male-sounding translated voice and manual playback only.
- Daily quota of 50 translations per user, tracked in Postgres.
- "Send transcript" emails the full conversation to the signed-in user.

## Getting started

```bash
npm install
cp .env.example .env   # then fill in the values
npm run db:migrate     # apply the schema to your database
npm run dev
```

Open http://localhost:3000.

### Environment variables

| Variable | Where to get it |
| --- | --- |
| `DATABASE_URL` | Neon dashboard → pooled connection string (keep `?sslmode=require`) |
| `DATABASE_URL_UNPOOLED` | Neon dashboard → direct connection string; used by Prisma migrations |
| `AUTH_SECRET` | `openssl rand -base64 32` |
| `AUTH_URL` | `http://localhost:3000` locally; leave unset on Vercel |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | Google Cloud Console → APIs & Services → Credentials → OAuth client |
| `GOOGLE_TRANSLATE_API_KEY` | Google Cloud Console → Credentials → API key (enable Cloud Translation API) |
| `OPENAI_API_KEY` | platform.openai.com; paid microphone transcription and TTS |
| `RESEND_API_KEY` | resend.com |
| `TRANSCRIPT_FROM` | Verified sender; `onboarding@resend.dev` works for testing |

Add `http://localhost:3000/api/auth/callback/google` (and the production equivalent) to the authorized redirect URIs of the Google OAuth client.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm start` | Serve the production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:generate` | Regenerate the Prisma client into `app/generated/prisma` |
| `npm run db:migrate` | Create and apply a migration (development) |
| `npm run db:deploy` | Apply pending migrations (CI / production) |

## Project layout

```
app/
  actions.ts              Server actions for sign-in / sign-out
  page.tsx                Landing page
  translate/page.tsx      Protected translator page
  api/translate/route.ts  Translation + quota enforcement
  api/transcribe/route.ts Authenticated OpenAI microphone transcription
  api/tts/route.ts        OpenAI speech synthesis
  api/transcript/route.ts Resend transcript email
  api/usage/route.ts      Current daily usage
components/
  TranslatorWorkspace.tsx Language pickers, panels, transcript controls
  UserBadge.tsx           Signed-in user + sign out
hooks/
  useSpeechRecognition.ts Continuous mic capture and ordered segment transcription
  useTtsPlayback.ts       Audio playback for synthesized speech
lib/
  auth.ts                 Auth.js configuration
  prisma.ts               Prisma client singleton
  languages.ts            Supported language metadata
  translate.ts            Google Translate client
  rate-limit.ts           Daily quota helpers
prisma/
  schema.prisma           Auth.js models + usage counter
proxy.ts                  Route protection
```

## Notes

- Microphone input requires HTTPS (or localhost), microphone permission, getUserMedia, AudioContext and AudioWorklet support. Mono PCM is captured continuously and packaged into independent 16-bit WAV segments every 1.2 seconds. Stop flushes the final segment. Activity is measured in 20 ms windows; segments with less than 80 ms of activity are discarded unless they continue speech across a segment boundary to reduce invented text during silence. This is an amplitude gate, not perfect speech detection: noise can pass it, and very quiet speech can be skipped.
- Input comes from the microphone, **not tab/system audio**. Accepted audio segments are sent through the authenticated server to OpenAI for paid transcription. Audio is not persisted by the app; provider retention follows your account policy. Obtain consent before recording private conversations.
- Stop releases the microphone and normally transcribes the final segment. Clear, a new session, language changes, or leaving the page discard pending results. Backgrounding stops capture. At most two requests and six pending segments are retained; slow service or recording failure stops capture with an error.
- Translation is manual: review the source, then click **Translate**. Editing the source or changing languages invalidates the displayed translation and cancels an in-flight request. Each explicit request counts toward the 50-translations-per-day quota. This is not a transcription billing limit.
- Playback is manual only. Click **Replay latest** to read the translated text, or **Stop** to cancel playback. The speech service is instructed to read only the provided text, without translating or appending other languages. Model output still requires real-device listening checks.
- Use headphones to prevent translated audio from being recorded by the microphone. Real iPhone/browser behavior and transcription accuracy still need device testing; words can cross segment boundaries.
- Without a verified Resend domain, transcripts can only be delivered to the Resend account owner's address.
