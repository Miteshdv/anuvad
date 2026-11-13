"use client";

import { useEffect, useRef, useState } from "react";
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
  targetCode: string;
  pending: boolean;
};

const DEFAULT_LIMIT = 50;

export default function TranslatorWorkspace() {
  const [sourceLang, setSourceLang] = useState(DEFAULT_SOURCE);
  const [targetLang, setTargetLang] = useState(DEFAULT_TARGET);
  const [speaker, setSpeaker] = useState("");
  const [voiceGender, setVoiceGender] = useState<"default" | "female" | "male">("default");
  const [draft, setDraft] = useState("");
  const [translatedDraft, setTranslatedDraft] = useState("");
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
  const { enabled: ttsEnabled } = tts;

  const speakerRef = useRef(speaker);
  const langsRef = useRef({ sourceLang, targetLang });
  const ttsEnabledRef = useRef(ttsEnabled);
  const audioEpochRef = useRef(0);
  const turnSeqRef = useRef(0);
  const epochRef = useRef(0);
  const translationsRef = useRef(new Set<AbortController>());
  const draftControllerRef = useRef<AbortController | null>(null);
  const draftTranslateTimerRef = useRef<number | null>(null);
  const sourceScrollRef = useRef<HTMLTextAreaElement | null>(null);
  const targetScrollRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    speakerRef.current = speaker;
  }, [speaker]);

  useEffect(() => {
    langsRef.current = { sourceLang, targetLang };
  }, [sourceLang, targetLang]);

  useEffect(() => {
    ttsEnabledRef.current = ttsEnabled;
  }, [ttsEnabled]);

  useEffect(() => () => {
    epochRef.current += 1;
    translationsRef.current.forEach((controller) => controller.abort());
    translationsRef.current.clear();
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 7000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const toastNotice = notice ?? (tts.error ? { kind: "error" as const, text: tts.error } : null);

  // Each phrase finalized by speech recognition becomes a translated chat line.
  const handleFinalSpeech = (text: string) => {
    const trimmed = text.replace(/\s+/g, " ").trim();
    if (!trimmed) return;
    setNotice(null);
    setDraft((current) => {
      const separator = current && !/[,.!?]\s*$/.test(current) ? " " : "";
      return `${current}${separator}${trimmed}`.trimStart();
    });

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
        targetCode: to,
        pending: false,
      },
    ]);

  };

  useEffect(() => {
    const text = draft.trim();
    if (draftTranslateTimerRef.current !== null) window.clearTimeout(draftTranslateTimerRef.current);
    draftControllerRef.current?.abort();
    if (!text) {
      draftTranslateTimerRef.current = window.setTimeout(() => setTranslatedDraft(""), 0);
      return;
    }

    const hasEndingPunctuation = /[.!?]$/.test(text);
    draftTranslateTimerRef.current = window.setTimeout(() => {
      const controller = new AbortController();
      draftControllerRef.current = controller;
      void (async () => {
        try {
          const { sourceLang: from, targetLang: to } = langsRef.current;
          const res = await fetch("/api/translate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text, from, to }),
            signal: controller.signal,
          });
          const payload = await res.json().catch(() => null) as
            | { translated?: string; used?: number; limit?: number; error?: string }
            | null;
          if (controller.signal.aborted) return;
          if (!res.ok || !payload?.translated) throw new Error(payload?.error ?? "Translation failed");
          setTranslatedDraft(payload.translated);
          if (typeof payload.used === "number") setUsed(payload.used);
          if (typeof payload.limit === "number") setLimit(payload.limit);
        } catch (error) {
          if (controller.signal.aborted) return;
          setNotice({ kind: "error", text: error instanceof Error ? error.message : "Translation failed" });
        }
      })();
    }, hasEndingPunctuation ? 120 : 350);

    return () => {
      if (draftTranslateTimerRef.current !== null) window.clearTimeout(draftTranslateTimerRef.current);
    };
  }, [draft, sourceLang, targetLang]);

  const speech = useSpeechRecognition({
    lang: sourceBcp47,
    getAudioEpoch: () => ttsEnabledRef.current ? audioEpochRef.current : null,
    onFinal: (text) => handleFinalSpeech(text),
  });

  const stopAudio = () => {
    audioEpochRef.current += 1;
    tts.stop();
  };

  const playTranslation = (text: string, lang: string) => {
    if (tts.playFromGesture(text, lang)) audioEpochRef.current += 1;
  };

  const clearAll = () => {
    epochRef.current += 1;
    translationsRef.current.forEach((controller) => controller.abort());
    translationsRef.current.clear();
    speech.reset();
    speech.stop(false);
    stopAudio();
    setDraft("");
    setTranslatedDraft("");
    setTurns([]);
    setNotice(null);
  };

  const swapLanguages = () => {
    setSourceLang(targetLang);
    setTargetLang(sourceLang);
    setDraft("");
    setTranslatedDraft("");
  };

  const sendTranscript = async () => {
    if (!draft.trim() || !translatedDraft.trim()) return;
    const completed = [{
      speaker: speaker.trim() || "Speaker 1",
      source: draft.trim(),
      target: translatedDraft.trim(),
      sourceLang: languageByCode(sourceLang)?.label ?? sourceLang,
      targetLang: languageByCode(targetLang)?.label ?? targetLang,
    }];
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
  const busy = turns.some((turn) => turn.pending);

  useEffect(() => {
    sourceScrollRef.current?.scrollTo({ top: sourceScrollRef.current.scrollHeight, behavior: "smooth" });
    targetScrollRef.current?.scrollTo({ top: targetScrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, liveDraft]);

  const toggleListening = () => {
    if (speech.listening) {
      stopAudio();
      speech.stop();
      return;
    }
    stopAudio();
    if (tts.enabled) tts.unlock();
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
              onChange={(event) => {
                const enabled = event.target.checked;
                ttsEnabledRef.current = enabled;
                tts.setEnabled(enabled);
                if (enabled) tts.unlock();
                else stopAudio();
              }}
            />
            Auto-play translation
          </label>

          <button
            type="button"
            className={`${styles.micButton} ${speech.listening ? styles.micActive : ""}`}
            onClick={toggleListening}
            disabled={speech.supported === false || (atLimit && !speech.listening)}
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
          Microphone recording is unavailable. Use an up-to-date browser over HTTPS (or localhost) and allow microphone access.
        </p>
      ) : null}

      {speech.error ? <p className={styles.warn} role="alert">{speech.error}</p> : null}

      <section className={styles.panels}>
        <article className={styles.panel}>
          <header className={styles.panelHead}>
            <h2>{languageByCode(sourceLang)?.label ?? "Source"}</h2>
            <span className={`${styles.pill} ${speech.listening ? styles.pillLive : ""}`} aria-live="polite">
              <span className={styles.dot} />
              {speech.listening ? "Listening" : `${turns.length} lines`}
            </span>
          </header>
          <textarea
            className={styles.editor}
            ref={(node) => { sourceScrollRef.current = node; }}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Type or speak in sentences with commas, periods, and exclamation marks…"
            spellCheck
            dir="auto"
            aria-label="Source text"
          />
        </article>

        <article className={styles.panel}>
          <header className={styles.panelHead}>
            <h2>{languageByCode(targetLang)?.label ?? "Target"}</h2>
            <span className={`${styles.pill} ${tts.speaking ? styles.pillSpeaking : ""}`}>
              <span className={styles.dot} />
              {tts.speaking ? "Speaking" : busy ? "Translating" : "Ready"}
            </span>
          </header>
          <textarea
            className={`${styles.editor} ${styles.translationEditor}`}
            ref={(node) => { targetScrollRef.current = node; }}
            value={translatedDraft}
            readOnly
            placeholder={busy ? "Translating…" : "Translation appears here as you type or speak."}
            dir={targetLang === "ar" ? "rtl" : "ltr"}
            aria-label="Translated text"
          />
          <footer className={styles.panelFoot}>
            <button type="button" className={styles.playButton} onClick={() => tts.speaking ? stopAudio() : translatedDraft ? playTranslation(translatedDraft, targetLang) : undefined} disabled={!tts.speaking && !translatedDraft}>
              {tts.speaking ? "◼ Stop" : "▶ Replay latest"}
            </button>
            <span className={styles.hint}>{tts.error ?? ""}</span>
          </footer>
        </article>
      </section>

      <div className={styles.chatFoot}>
        <span className={styles.hint}>
          {atLimit ? "Daily limit reached" : speech.listening ? "Listening live — spoken text is transcribed in short segments and translated as it appears." : `${draft.length} characters · ${used}/${limit} translations today`}
        </span>
        <div className={styles.footerActions}>
          <button type="button" className={styles.secondaryButton} onClick={() => { speech.reset(); setDraft(""); setTranslatedDraft(""); setNotice(null); }} disabled={!draft && !speech.interim}>Clear text</button>
          <button type="button" className={styles.secondaryButton} onClick={clearAll} disabled={turns.length === 0 && !draft && !speech.interim}>Clear all</button>
          <button type="button" className={styles.primaryButton} onClick={sendTranscript} disabled={!draft.trim() || !translatedDraft.trim() || sending}>{sending ? "Sending…" : "Send transcript"}</button>
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
