"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LANGUAGES, DEFAULT_SOURCE, DEFAULT_TARGET, languageByCode } from "@/lib/languages";
import { useSpeechRecognition } from "@/hooks/useSpeechRecognition";
import { useTtsPlayback } from "@/hooks/useTtsPlayback";
import styles from "./TranslatorWorkspace.module.css";

type Turn = {
  id: string;
  speaker: string;
  source: string;
  target: string;
  sourceLang: string;
  targetLang: string;
  pending: boolean;
};

const DEFAULT_LIMIT = 50;

export default function TranslatorWorkspace() {
  const [sourceLang, setSourceLang] = useState(DEFAULT_SOURCE);
  const [targetLang, setTargetLang] = useState(DEFAULT_TARGET);
  const [speaker, setSpeaker] = useState("");
  const [voiceGender, setVoiceGender] = useState<"default" | "female" | "male">("default");
  const [draft, setDraft] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [used, setUsed] = useState(0);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [notice, setNotice] = useState<{ kind: "error" | "ok"; text: string } | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch("/api/usage");
      if (!res.ok) return;
      const payload = (await res.json()) as { used?: number; limit?: number };
      if (cancelled) return;
      if (typeof payload.used === "number") setUsed(payload.used);
      if (typeof payload.limit === "number") setLimit(payload.limit);
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const sourceBcp47 = languageByCode(sourceLang)?.bcp47 ?? "en-US";

  const tts = useTtsPlayback(targetLang, voiceGender);
  const { speak: speakTranslation, enabled: ttsEnabled } = tts;

  const speakerRef = useRef(speaker);
  const langsRef = useRef({ sourceLang, targetLang });
  const ttsEnabledRef = useRef(ttsEnabled);
  const speakRef = useRef(speakTranslation);
  const turnSeqRef = useRef(0);
  const epochRef = useRef(0);
  const sourceScrollRef = useRef<HTMLDivElement | null>(null);
  const targetScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    speakerRef.current = speaker;
  }, [speaker]);

  useEffect(() => {
    langsRef.current = { sourceLang, targetLang };
  }, [sourceLang, targetLang]);

  useEffect(() => {
    ttsEnabledRef.current = ttsEnabled;
  }, [ttsEnabled]);

  useEffect(() => {
    speakRef.current = speakTranslation;
  }, [speakTranslation]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 7000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const toastNotice = notice ?? (tts.error ? { kind: "error" as const, text: tts.error } : null);

  const translateTurn = useCallback(async (turnId: string, text: string) => {
    const { sourceLang: from, targetLang: to } = langsRef.current;
    const epoch = epochRef.current;

    try {
      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, from, to }),
      });
      const payload = (await res.json().catch(() => null)) as
        | { translated?: string; used?: number; limit?: number; error?: string }
        | null;
      if (epoch !== epochRef.current) return;

      if (!res.ok || !payload?.translated) {
        const errorMessage = payload?.error ?? `Translation failed (${res.status})`;
        setTurns((prev) =>
          prev.map((turn) =>
            turn.id === turnId
              ? { ...turn, pending: false, target: "" }
              : turn,
          ),
        );
        setNotice({ kind: "error", text: errorMessage });
        return;
      }

      const translated = payload.translated;
      if (typeof payload.used === "number") setUsed(payload.used);
      setTurns((prev) =>
        prev.map((turn) => (turn.id === turnId ? { ...turn, pending: false, target: translated } : turn)),
      );

      if (ttsEnabledRef.current) void speakRef.current(translated);
    } catch (error) {
      if (epoch !== epochRef.current) return;
      const message = error instanceof Error ? error.message : "Translation failed";
      setTurns((prev) =>
        prev.map((turn) => (turn.id === turnId ? { ...turn, pending: false, target: "" } : turn)),
      );
      setNotice({ kind: "error", text: message });
    }
  }, []);

  // Each phrase finalized by speech recognition becomes a translated chat line.
  const handleFinalSpeech = useCallback(
    (text: string) => {
      const trimmed = text.replace(/\s+/g, " ").trim();
      if (!trimmed) return;
      setNotice(null);

      turnSeqRef.current += 1;
      const id = `${Date.now()}-${turnSeqRef.current}`;
      const { sourceLang: from, targetLang: to } = langsRef.current;

      setTurns((prev) => [
        ...prev,
        {
          id,
          speaker: speakerRef.current.trim() || "Speaker 1",
          source: trimmed,
          target: "",
          sourceLang: languageByCode(from)?.label ?? from,
          targetLang: languageByCode(to)?.label ?? to,
          pending: true,
        },
      ]);

      void translateTurn(id, trimmed);
    },
    [translateTurn],
  );

  const speech = useSpeechRecognition({
    lang: sourceBcp47,
    onFinal: handleFinalSpeech,
  });

  const clearAll = () => {
    epochRef.current += 1;
    speech.reset();
    speech.stop(false);
    tts.stop();
    setDraft("");
    setTurns([]);
    setNotice(null);
  };

  const retryTurn = (id: string) => {
    const turn = turns.find((item) => item.id === id);
    if (!turn) return;
    setTurns((prev) => prev.map((item) => (item.id === id ? { ...item, pending: true, target: "" } : item)));
    void translateTurn(id, turn.source);
  };

  const swapLanguages = () => {
    setSourceLang(targetLang);
    setTargetLang(sourceLang);
    setDraft("");
  };

  const sendTranscript = async () => {
    const completed = turns.filter((turn) => !turn.pending && turn.target);
    if (completed.length === 0) return;
    setSending(true);
    setNotice(null);
    try {
      const res = await fetch("/api/transcript", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          turns: completed.map(({ speaker: sp, source, target, sourceLang: sl, targetLang: tl }) => ({
            speaker: sp,
            source,
            target,
            sourceLang: sl,
            targetLang: tl,
          })),
        }),
      });
      const payload = (await res.json().catch(() => null)) as
        | { ok?: boolean; sentTo?: string; error?: string }
        | null;

      if (!res.ok || !payload?.ok) {
        setNotice({ kind: "error", text: payload?.error ?? "Could not send transcript" });
        return;
      }
      setNotice({ kind: "ok", text: `Transcript sent to ${payload.sentTo}` });
    } catch (error) {
      setNotice({
        kind: "error",
        text: error instanceof Error ? error.message : "Could not send transcript",
      });
    } finally {
      setSending(false);
    }
  };

  const atLimit = used >= limit;
  const liveDraft = speech.interim;
  const lastTurn = turns[turns.length - 1];
  const busy = turns.some((turn) => turn.pending);
  const speakerLabel = speaker.trim() || "Speaker 1";

  useEffect(() => {
    sourceScrollRef.current?.scrollTo({ top: sourceScrollRef.current.scrollHeight, behavior: "smooth" });
    targetScrollRef.current?.scrollTo({ top: targetScrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, liveDraft]);

  const toggleListening = () => {
    if (speech.listening) {
      speech.stop();
      return;
    }
    tts.stop();
    speech.start();
  };

  return (
    <main className={styles.workspace}>
      <section className={styles.bar}>
        <div className={styles.pickers}>
          <label className={styles.speakerField}>
            <span className={styles.pickerLabel}>Speaker</span>
            <input
              type="text"
              value={speaker}
              onChange={(event) => setSpeaker(event.target.value)}
              placeholder="Your name"
              maxLength={40}
              spellCheck={false}
            />
          </label>

          <label className={styles.picker}>
            <span className={styles.pickerLabel}>From</span>
            <select
              value={sourceLang}
              onChange={(event) => setSourceLang(event.target.value)}
              disabled={speech.listening}
            >
              {LANGUAGES.map((language) => (
                <option key={language.code} value={language.code}>
                  {language.flag} {language.label}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            className={styles.swap}
            onClick={swapLanguages}
            title="Swap languages"
            aria-label="Swap languages"
          >
            ⇄
          </button>

          <label className={styles.picker}>
            <span className={styles.pickerLabel}>To</span>
            <select
              value={targetLang}
              onChange={(event) => setTargetLang(event.target.value)}
              disabled={speech.listening}
            >
              {LANGUAGES.map((language) => (
                <option key={language.code} value={language.code}>
                  {language.flag} {language.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className={styles.barRight}>
          <label className={styles.picker}>
            <span className={styles.pickerLabel}>Voice</span>
            <select
              value={voiceGender}
              onChange={(event) => setVoiceGender(event.target.value as typeof voiceGender)}
            >
              <option value="default">Default</option>
              <option value="female">Female</option>
              <option value="male">Male</option>
            </select>
          </label>
          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={tts.enabled}
              onChange={(event) => tts.setEnabled(event.target.checked)}
            />
            Auto-play translation
          </label>

          <button
            type="button"
            className={`${styles.micButton} ${speech.listening ? styles.micActive : ""}`}
            onClick={toggleListening}
            disabled={speech.supported === false || atLimit}
          >
            <span className={styles.micIcon} aria-hidden="true">
              {speech.listening ? "■" : "🎙"}
            </span>
            {speech.listening ? "Stop listening" : "Start listening"}
          </button>
        </div>
      </section>

      {speech.supported === false ? (
        <p className={styles.warn}>
          This browser does not support the Web Speech API. Use Chrome or Edge to dictate.
        </p>
      ) : null}

      {speech.error ? <p className={styles.warn}>{speech.error}</p> : null}

      <section className={styles.panels}>
        <article className={styles.panel}>
          <header className={styles.panelHead}>
            <h2>{languageByCode(sourceLang)?.label ?? "Source"}</h2>
            <span className={`${styles.pill} ${speech.listening ? styles.pillLive : ""}`} aria-live="polite">
              <span className={styles.dot} />
              {speech.listening ? "Listening" : `${turns.length} lines`}
            </span>
          </header>
          <div className={styles.transcript} ref={sourceScrollRef}>
            {turns.length === 0 && !liveDraft ? (
              <p className={styles.empty}>Press <strong>Start listening</strong> and speak. Completed phrases appear here as they are recognized.</p>
            ) : null}
            {turns.map((turn) => (
              <article key={turn.id} className={styles.turn}>
                <div className={styles.turnHead}>
                  <span className={styles.turnSpeaker}>{turn.speaker}</span>
                  <span className={styles.turnMeta}>{turn.sourceLang}</span>
                </div>
                <p className={styles.turnSource}>{turn.source}</p>
              </article>
            ))}
            {liveDraft ? (
              <article className={`${styles.turn} ${styles.turnLive}`}>
                <div className={styles.turnHead}>
                  <span className={styles.turnSpeaker}>{speakerLabel}</span>
                  <span className={styles.turnMeta}>listening…</span>
                </div>
                <p className={styles.turnSource}>{liveDraft}</p>
              </article>
            ) : null}
          </div>
          <footer className={styles.composer}>
            <textarea
              className={styles.composerInput}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Type a phrase to translate…"
              spellCheck={false}
              rows={2}
            />
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => {
                if (!draft.trim()) return;
                setDraft("");
                handleFinalSpeech(draft);
              }}
              disabled={!draft.trim() || atLimit}
            >
              Translate
            </button>
          </footer>
        </article>

        <article className={styles.panel}>
          <header className={styles.panelHead}>
            <h2>{languageByCode(targetLang)?.label ?? "Target"}</h2>
            <span className={`${styles.pill} ${tts.speaking ? styles.pillSpeaking : ""}`}>
              <span className={styles.dot} />
              {tts.speaking ? "Speaking" : busy ? "Translating" : "Ready"}
            </span>
          </header>
          <div className={styles.transcript} ref={targetScrollRef} dir={targetLang === "ar" ? "rtl" : "ltr"}>
            {turns.length === 0 ? <p className={styles.empty}>Translations appear here alongside each source phrase.</p> : null}
            {turns.map((turn) => (
              <article key={turn.id} className={styles.turn}>
                <div className={styles.turnHead}>
                  <span className={styles.turnSpeaker}>{turn.speaker}</span>
                  <span className={styles.turnMeta}>{turn.targetLang}</span>
                </div>
                <div className={styles.turnTargetRow}>
                  <p className={`${styles.turnTarget} ${turn.pending ? styles.turnPending : ""}`}>
                    {turn.pending ? "Translating…" : turn.target}
                  </p>
                  <div className={styles.turnActions}>
                    <button type="button" className={styles.iconButton} onClick={() => (tts.speaking ? tts.stop() : void tts.speak(turn.target))} disabled={turn.pending || !turn.target} title="Play translation" aria-label="Play translation">▶</button>
                    <button type="button" className={styles.iconButton} onClick={() => retryTurn(turn.id)} disabled={turn.pending} title="Translate again" aria-label="Translate again">↻</button>
                  </div>
                </div>
              </article>
            ))}
          </div>
          <footer className={styles.panelFoot}>
            <button type="button" className={styles.playButton} onClick={() => tts.speaking ? tts.stop() : lastTurn?.target ? void tts.speak(lastTurn.target) : undefined} disabled={!lastTurn?.target || busy}>
              {tts.speaking ? "◼ Stop" : "▶ Replay latest"}
            </button>
            <span className={styles.hint}>{tts.error ?? ""}</span>
          </footer>
        </article>
      </section>

      <div className={styles.chatFoot}>
        <span className={styles.hint}>
          {atLimit ? "Daily limit reached" : speech.listening ? "Listening — each recognized phrase is translated immediately." : `${turns.length} turns · ${used}/${limit} translations today`}
        </span>
        <div className={styles.footerActions}>
          <button type="button" className={styles.secondaryButton} onClick={() => { speech.reset(); setDraft(""); setNotice(null); }} disabled={!draft && !speech.interim}>Reset line</button>
          <button type="button" className={styles.secondaryButton} onClick={clearAll} disabled={turns.length === 0 && !draft && !speech.interim}>Reset chat</button>
          <button type="button" className={styles.primaryButton} onClick={sendTranscript} disabled={turns.length === 0 || turns.every((turn) => turn.pending) || sending}>{sending ? "Sending…" : "Send transcript"}</button>
        </div>
      </div>
      {toastNotice ? (
        <div
          className={`${styles.toast} ${toastNotice.kind === "error" ? styles.toastError : styles.toastOk}`}
          role={toastNotice.kind === "error" ? "alert" : "status"}
          aria-live={toastNotice.kind === "error" ? "assertive" : "polite"}
        >
          <span>{toastNotice.text}</span>
          <button
            type="button"
            className={styles.toastClose}
            onClick={() => {
              setNotice(null);
              tts.clearError();
            }}
            aria-label="Dismiss notification"
          >
            ×
          </button>
        </div>
      ) : null}
    </main>
  );
}
