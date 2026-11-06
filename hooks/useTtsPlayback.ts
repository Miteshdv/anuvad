"use client";

import { useEffect, useRef, useState } from "react";
import { TtsPlayback } from "@/lib/ttsPlayback";

export function useTtsPlayback(lang: string, gender: "default" | "female" | "male" = "default") {
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(true);
  const playerRef = useRef<TtsPlayback | null>(null);
  const lastRequestRef = useRef<{ text: string; lang: string; gender: typeof gender } | null>(null);

  const getPlayer = () => {
    if (!playerRef.current) {
      playerRef.current = new TtsPlayback({ onSpeakingChange: setSpeaking, onError: setError });
    }
    return playerRef.current;
  };

  useEffect(() => () => {
    playerRef.current?.dispose();
    playerRef.current = null;
  }, []);

  const stop = () => {
    playerRef.current?.stop();
    lastRequestRef.current = null;
    setError(null);
  };

  const unlock = () => getPlayer().unlock();
  const clearError = () => setError(null);
  const speak = (text: string) => {
    if (!text.trim()) return Promise.resolve();
    const request = { text, lang, gender };
    lastRequestRef.current = request;
    return getPlayer().speak(request);
  };

  const playFromGesture = (text: string) => {
    const last = lastRequestRef.current;
    const player = getPlayer();
    if (last?.text === text && last.lang === lang && last.gender === gender && player.replay()) return;
    player.stop();
    player.unlock();
    void speak(text);
  };

  return { speak, playFromGesture, unlock, stop, speaking, error, enabled, setEnabled, clearError };
}
