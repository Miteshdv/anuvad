"use client";

import { useEffect, useRef, useState } from "react";
import { TtsPlayback } from "@/lib/ttsPlayback";

export function useTtsPlayback(lang: string, gender: "default" | "female" | "male" = "default") {
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(true);
  const playerRef = useRef<TtsPlayback | null>(null);

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
    setError(null);
  };

  const unlock = () => getPlayer().unlock();
  const clearError = () => setError(null);
  const reserve = (targetLang: string) => {
    const complete = getPlayer().reserve();
    return (text: string | null) => complete(text ? { text, lang: targetLang, gender } : null);
  };

  const playFromGesture = (text: string, targetLang = lang) => {
    const player = getPlayer();
    const request = { text, lang: targetLang, gender };
    if (player.replay(request)) return false;
    player.stop();
    player.unlock();
    void player.speak(request);
    return true;
  };

  return { reserve, playFromGesture, unlock, stop, speaking, error, enabled, setEnabled, clearError };
}
