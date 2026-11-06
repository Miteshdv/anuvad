# Anuvad

Browser-based speech translation. Start listening, speak naturally, and see short audio segments transcribed and translated in side-by-side conversation panes after a short delay. Choose the translated voice, play speech, and email yourself the transcript.

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
- Click-to-toggle microphone recording with ordered short-segment transcription and translation.
- Side-by-side source and translated conversation panes, with per-line playback and retry.
- Selectable default, female-sounding, or male-sounding translated voice and optional auto-play.
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

- Microphone input requires HTTPS (or localhost), microphone permission, getUserMedia, AudioContext and AudioWorklet support. A single continuous audio graph captures mono PCM without restarting the microphone recorder. Every 1.2 seconds, samples are wrapped in an independent 16-bit WAV file with its own RIFF/WAVE header; Stop flushes the remaining partial segment. This avoids WebM/MP4 container fragmentation during longer speech. WAV uploads use more bandwidth (about 96 KB/s at 48 kHz). Words may still cross segment boundaries, and transcription plus translation requires network round trips; this is not zero-latency word-by-word translation.
- Input comes from the microphone, **not tab/system audio**. Microphone audio (including silence/background sounds) is sent through the authenticated server to OpenAI for paid `gpt-4o-mini-transcribe` processing. The app does not persist audio; OpenAI processing/retention follows your provider account policy. Do not record private conversations without consent.
- Stop releases the microphone immediately and normally transcribes the final segment. Reset, a new session, language changes, or leaving the page discard pending results. Backgrounding the page stops recording; interruptions require starting again. At most two requests and six pending segments are retained; slow service/backpressure, timeout, or recording failure stops capture with an error rather than silently losing an unbounded backlog. Turning Auto-play off affects playback only.
- Real iPhone/browser recording behavior still needs device testing. Silence recognition and segment boundaries can affect accuracy; this is not seamless movie-length transcription.
- The existing daily limit is **50 translated phrases**, unchanged. Each nonempty segment may count as a phrase; extended sessions reach the cap quickly. This translation quota is not a transcription billing limit: recording/transcription can incur costs even for silence or failed translations. Stop recording when not needed.
- Auto-play is enabled by default. Translated phrases play in conversation order, even if translations finish out of order. Manual line playback replaces current and queued audio; Stop, reset, and disabling auto-play cancel it. Transcripts still receive pending microphone segments after Stop, but their audio does not automatically play. Start listening, translate typed text, or enable auto-play to prepare audio playback. If the browser blocks playback, the queue waits: use the blocked line's play button to resume, or choose another line to replace it. Allow sound for the site. Translations can still be played manually with auto-play off.
- Use headphones when listening and speaking to reduce the chance that the microphone picks up translated audio.
- Without a verified Resend domain, transcripts can only be delivered to the Resend account owner's address.
