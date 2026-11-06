# Anuvad

Browser-based speech translation. Start listening, speak naturally, and see each recognized phrase translated immediately in side-by-side conversation panes. Choose the translated voice, play speech, and email yourself the transcript.

## Stack

| Concern | Choice |
| --- | --- |
| Framework | Next.js 16 (App Router, Cache Components) |
| Auth | Auth.js v5 with Google provider, database sessions |
| Database | Neon Postgres via Prisma 7 (`@prisma/adapter-pg`) |
| Translation | Google Cloud Translation v2 REST |
| Text-to-speech | OpenAI `gpt-4o-mini-tts` |
| Email | Resend |
| Speech input | Browser Web Speech API (Chrome / Edge) |

## Features

- Google sign-in; `/translate` is protected by `proxy.ts`.
- Ten source/target languages with a swap control.
- Click-to-toggle dictation with live interim text and phrase-by-phrase translation.
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
| `OPENAI_API_KEY` | platform.openai.com |
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
  api/tts/route.ts        OpenAI speech synthesis
  api/transcript/route.ts Resend transcript email
  api/usage/route.ts      Current daily usage
components/
  TranslatorWorkspace.tsx Language pickers, panels, transcript controls
  UserBadge.tsx           Signed-in user + sign out
hooks/
  useSpeechRecognition.ts Web Speech API wrapper
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

- Speech recognition requires Chrome or Edge; the UI warns on unsupported browsers.
- Auto-play is enabled by default. Start listening, translate typed text, or enable auto-play to prepare audio playback. If your browser blocks it, use the line's play button or **Replay latest** and allow sound for the site. Turning auto-play off stops automatic audio; you can still play translations manually.
- Use headphones when listening and speaking to reduce the chance that the microphone picks up translated audio.
- Without a verified Resend domain, transcripts can only be delivered to the Resend account owner's address.
