"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string; message?: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: {
      isFinal: boolean;
      length: number;
      [index: number]: { transcript: string };
    };
  };
};

type RecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function subscribeSpeechSupport(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("pageshow", callback);
  return () => window.removeEventListener("pageshow", callback);
}

export type UseSpeechRecognitionOptions = {
  lang: string;
  onFinal: (text: string) => void;
};

export function useSpeechRecognition({ lang, onFinal }: UseSpeechRecognitionOptions) {
  const supported = useSyncExternalStore(
    subscribeSpeechSupport,
    () => getRecognitionCtor() !== null,
    () => true,
  );
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const onFinalRef = useRef(onFinal);
  const wantListeningRef = useRef(false);
  const restartTimerRef = useRef<number | null>(null);
  const restartDelayRef = useRef(250);
  // Live, non-final transcript shown while the current phrase is being recognized.
  const interimRef = useRef("");
  // Set while stopping the engine intentionally to ignore trailing results.
  const flushingRef = useRef(false);

  useEffect(() => {
    onFinalRef.current = onFinal;
  }, [onFinal]);

  const commitPhrase = useCallback((text: string) => {
    const phrase = text.replace(/\s+/g, " ").trim();
    if (phrase) onFinalRef.current(phrase);
  }, []);

  useEffect(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;

    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.lang = "en-US";

    const clearRestartTimer = () => {
      if (restartTimerRef.current !== null) {
        window.clearTimeout(restartTimerRef.current);
        restartTimerRef.current = null;
      }
    };

    const scheduleRestart = () => {
      if (!wantListeningRef.current || restartTimerRef.current !== null) return;
      restartTimerRef.current = window.setTimeout(() => {
        restartTimerRef.current = null;
        if (!wantListeningRef.current) return;
        try {
          recognition.start();
          restartDelayRef.current = 250;
        } catch {
          restartDelayRef.current = Math.min(restartDelayRef.current * 2, 4000);
          scheduleRestart();
        }
      }, restartDelayRef.current);
    };

    recognition.onstart = () => {
      clearRestartTimer();
      restartDelayRef.current = 250;
      setListening(true);
      setError(null);
    };

    recognition.onresult = (event) => {
      if (flushingRef.current) return;

      let pendingInterim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? "";
        if (result.isFinal) {
          commitPhrase(transcript);
        } else {
          pendingInterim += transcript;
        }
      }
      interimRef.current = pendingInterim.trim();
      setInterim(pendingInterim);
    };

    recognition.onerror = (event) => {
      if (event.error === "aborted") return;
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        wantListeningRef.current = false;
        setListening(false);
        setError("Microphone permission was denied or blocked.");
        return;
      }
      if (event.error === "no-speech") return;
      setError(event.message || event.error);
    };

    recognition.onend = () => {
      flushingRef.current = false;
      if (!wantListeningRef.current) {
        clearRestartTimer();
        setListening(false);
        setInterim("");
        interimRef.current = "";
        return;
      }

      // Browser speech services can end a recognition session between phrases.
      // Keep the user's listening session active and restart with a short backoff.
      scheduleRestart();
    };

    recognitionRef.current = recognition;
    return () => {
      wantListeningRef.current = false;
      clearRestartTimer();
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.onstart = null;
      try {
        recognition.abort();
      } catch {
        // already stopped
      }
      recognitionRef.current = null;
    };
  }, [commitPhrase]);

  useEffect(() => {
    if (recognitionRef.current) recognitionRef.current.lang = lang;
  }, [lang]);


  const start = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition || wantListeningRef.current) return;
    wantListeningRef.current = true;
    restartDelayRef.current = 250;
    interimRef.current = "";
    try {
      recognition.start();
      setError(null);
    } catch {
      wantListeningRef.current = false;
      setListening(false);
      setError("Could not start speech recognition. Try starting again.");
    }
  }, []);

  const stop = useCallback(
    (commit = true) => {
      wantListeningRef.current = false;
      if (restartTimerRef.current !== null) {
        window.clearTimeout(restartTimerRef.current);
        restartTimerRef.current = null;
      }
      setListening(false);
      const finalText = interimRef.current;
      interimRef.current = "";
      setInterim("");
      if (commit) commitPhrase(finalText);
      const recognition = recognitionRef.current;
      if (!recognition) return;
      flushingRef.current = true;
      try {
        recognition.stop();
      } catch {
        try {
          recognition.abort();
        } catch {
          flushingRef.current = false;
        }
      }
    },
    [commitPhrase],
  );

  const reset = useCallback(() => {
    interimRef.current = "";
    setInterim("");
    setError(null);
  }, []);

  return { supported, listening, interim, error, start, stop, reset };
}
