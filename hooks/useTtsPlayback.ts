"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export function useTtsPlayback(lang: string, gender: "default" | "female" | "male" = "default") {
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(true);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const cleanup = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    audioRef.current?.pause();
    audioRef.current = null;
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const stop = useCallback(() => {
    cleanup();
    setSpeaking(false);
  }, [cleanup]);

  const clearError = useCallback(() => setError(null), []);

  const speak = useCallback(
    async (text: string) => {
      if (!text.trim()) return;
      stop();

      const controller = new AbortController();
      abortRef.current = controller;
      setError(null);

      try {
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, lang, gender }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as { error?: string } | null;
          setError(payload?.error ?? `TTS failed (${res.status})`);
          return;
        }

        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        urlRef.current = url;

        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = () => setSpeaking(false);
        audio.onerror = () => {
          setError("Could not play audio.");
          setSpeaking(false);
        };

        setSpeaking(true);
        await audio.play();
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "TTS failed");
        setSpeaking(false);
      }
    },
    [gender, lang, stop],
  );

  return { speak, stop, speaking, error, enabled, setEnabled, clearError };
}
