"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

const SEGMENT_MS = 4000;
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const MAX_PENDING = 6;
const MIME_TYPES = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"];

function recordingMime() {
  if (typeof MediaRecorder === "undefined") return null;
  return MIME_TYPES.find((mime) => MediaRecorder.isTypeSupported(mime)) ?? null;
}

function subscribeSupport(callback: () => void) {
  window.addEventListener("pageshow", callback);
  return () => window.removeEventListener("pageshow", callback);
}

export type UseSpeechRecognitionOptions = {
  lang: string;
  onFinal: (text: string, audioEpoch?: number | null) => void;
  getAudioEpoch?: () => number | null;
};

type Session = { valid: boolean; capturing: boolean; stop: (commit: boolean) => void };
type Job = { audio: Blob; audioEpoch?: number | null; text?: string; done: boolean; started: boolean };

export function useSpeechRecognition({ lang, onFinal, getAudioEpoch }: UseSpeechRecognitionOptions) {
  const supported = useSyncExternalStore(subscribeSupport,
    () => typeof navigator.mediaDevices?.getUserMedia === "function" && recordingMime() !== null, () => true);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const mountedRef = useRef(false);
  const onFinalRef = useRef(onFinal);
  const getAudioEpochRef = useRef(getAudioEpoch);

  useEffect(() => { onFinalRef.current = onFinal; }, [onFinal]);
  useEffect(() => { getAudioEpochRef.current = getAudioEpoch; }, [getAudioEpoch]);
  useEffect(() => {
    mountedRef.current = true;
    const interrupt = () => {
      sessionRef.current?.stop(true);
    };
    const hidden = () => { if (document.visibilityState === "hidden") interrupt(); };
    window.addEventListener("pagehide", interrupt);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      mountedRef.current = false;
      sessionRef.current?.stop(false);
      window.removeEventListener("pagehide", interrupt);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  useEffect(() => { sessionRef.current?.stop(false); }, [lang]);

  const start = () => {
    if (!mountedRef.current || sessionRef.current?.capturing) return;
    sessionRef.current?.stop(false);
    const mime = recordingMime();
    if (!navigator.mediaDevices?.getUserMedia || !mime) {
      setError("Microphone recording is unavailable. Use an up-to-date browser over HTTPS (or localhost).");
      return;
    }
    let capturing = true;
    let stream: MediaStream | null = null;
    let current: MediaRecorder | null = null;
    let segmentTimer: number | undefined;
    let activeRequests = 0;
    const recorders = new Set<MediaRecorder>();
    const controllers = new Set<AbortController>();
    const timers = new Set<number>();
    const jobs: Job[] = [];
    const live = () => session.valid && mountedRef.current;
    const later = (fn: () => void, ms: number) => {
      const id = window.setTimeout(() => { timers.delete(id); fn(); }, ms);
      timers.add(id);
      return id;
    };
    const clearTimer = (id: number | undefined) => {
      if (id !== undefined) { window.clearTimeout(id); timers.delete(id); }
    };
    const releaseMic = () => {
      stream?.getTracks().forEach((track) => {
        track.onended = null;
        track.onmute = null;
        track.stop();
      });
      stream = null;
    };
    const updateDraft = () => {
      if (live()) setInterim(capturing ? "Recording audio..." : jobs.length ? "Transcribing audio..." : "");
    };
    const stopCapture = (commit: boolean) => {
      capturing = false;
      session.capturing = false;
      clearTimer(segmentTimer);
      if (commit && !stream && recorders.size === 0 && jobs.length === 0) commit = false;
      if (!commit) {
        session.valid = false;
        controllers.forEach((controller) => controller.abort());
        timers.forEach((id) => window.clearTimeout(id));
        timers.clear();
        jobs.length = 0;
      }
      for (const recorder of recorders) {
        if (!commit) {
          recorder.ondataavailable = null;
          recorder.onstop = null;
          recorder.onerror = null;
          recorder.onpause = null;
        }
        if (recorder.state !== "inactive") {
          if (commit) later(() => { if (recorders.has(recorder)) fail("The browser could not finish recording the final audio segment."); }, 2000);
          try { recorder.stop(); } catch { /* Release the stream even if the recorder already ended. */ }
        }
      }
      if (!commit) recorders.clear();
      releaseMic();
      if (mountedRef.current) {
        setListening(false);
        if (!commit) setInterim("");
        else updateDraft();
      }
    };
    const session: Session = { valid: true, capturing: true, stop: stopCapture };
    sessionRef.current = session;
    const fail = (message: string) => {
      if (!live()) return;
      stopCapture(false);
      setError(message);
    };
    const pump = () => {
      if (!live()) return;
      while (jobs[0]?.done) {
        const job = jobs.shift()!;
        if (job.text) onFinalRef.current(job.text, job.audioEpoch);
        if (!live()) return;
      }
      updateDraft();
      for (const job of jobs) {
        if (activeRequests >= 2) break;
        if (job.started) continue;
        job.started = true;
        activeRequests++;
        const controller = new AbortController();
        controllers.add(controller);
        const timeout = later(() => controller.abort(), 30000);
        const form = new FormData();
        form.append("file", job.audio, mime.startsWith("audio/mp4") ? "segment.mp4" : "segment.webm");
        form.append("language", lang.split("-")[0]);
        void (async () => {
          try {
            const response = await fetch("/api/transcribe", { method: "POST", body: form, signal: controller.signal });
            const payload = await response.json();
            if (!live()) return;
            if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : "Audio transcription failed. Try again.");
            if (typeof payload?.text !== "string") throw new Error("Invalid transcription response. Try again.");
            job.text = payload.text.replace(/\s+/g, " ").trim();
            job.done = true;
          } catch (cause) {
            fail(controller.signal.aborted ? "Audio transcription timed out. Check your connection and start listening again." :
              cause instanceof Error ? cause.message : "Audio transcription failed. Try again.");
          } finally {
            clearTimer(timeout);
            controllers.delete(controller);
            activeRequests--;
            pump();
          }
        })();
      }
    };
    const beginSegment = () => {
      if (!live() || !capturing || !stream) return;
      if (jobs.length + recorders.size >= MAX_PENDING) {
        fail("Transcription cannot keep up with recording. Pending audio was discarded. Check your connection and start listening again.");
        return;
      }
      try {
        const recorder = new MediaRecorder(stream, { mimeType: mime });
        const audioEpoch = getAudioEpochRef.current?.();
        current = recorder;
        recorders.add(recorder);
        const chunks: Blob[] = [];
        let bytes = 0;
        let expectedEnd = false;
        let endTimer: number | undefined;
        recorder.ondataavailable = (event) => {
          if (!live()) return;
          bytes += event.data.size;
          if (bytes > MAX_AUDIO_BYTES) { fail("Recorded audio exceeded the segment size limit. Start listening again."); return; }
          if (event.data.size) chunks.push(event.data);
        };
        recorder.onerror = () => fail("Microphone recording failed or was interrupted. Start listening again.");
        recorder.onpause = () => fail("Microphone recording was paused by the browser. Start listening again.");
        recorder.onstop = () => {
          clearTimer(endTimer);
          recorders.delete(recorder);
          if (!live()) return;
          if (capturing && !expectedEnd) {
            fail("Microphone recording ended unexpectedly. Start listening again.");
            return;
          }
          if (bytes) {
            jobs.push({ audio: new Blob(chunks, { type: recorder.mimeType || mime }), audioEpoch, done: false, started: false });
          }
          pump();
          beginSegment();
        };
        // Each fresh recorder produces a complete container, unlike timeslice fragments.
        recorder.start();
        segmentTimer = later(() => {
          if (!live() || !capturing || current !== recorder) return;
          expectedEnd = true;
          endTimer = later(() => fail("The browser stopped delivering microphone audio. Start listening again."), 2000);
          recorder.stop();
        }, SEGMENT_MS);
      } catch {
        fail("Could not start microphone recording. Check microphone access and try again.");
      }
    };
    setError(null);
    setListening(true);
    setInterim("Waiting for microphone permission...");
    void (async () => {
      try {
        const acquired = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (!live() || !capturing) { acquired.getTracks().forEach((track) => track.stop()); return; }
        stream = acquired;
        const tracks = stream.getAudioTracks();
        if (!tracks.length || tracks.some((track) => track.readyState === "ended")) {
          fail("No active microphone is available."); return;
        }
        tracks.forEach((track) => {
          track.onended = () => fail("Microphone access ended. Start listening again.");
          track.onmute = () => fail("Microphone input was interrupted. Start listening again.");
        });
        beginSegment();
        updateDraft();
      } catch (cause) {
        const name = cause instanceof Error ? cause.name : "";
        fail(name === "NotAllowedError" || name === "SecurityError"
          ? "Microphone permission was denied or blocked. Allow microphone access in your browser settings."
          : "Could not access a microphone. Check that one is connected and not in use by another app.");
      }
    })();
  };

  const stop = (commit = true) => { sessionRef.current?.stop(commit); };
  const reset = () => { stop(false); setInterim(""); setError(null); };
  return { supported, listening, interim, error, start, stop, reset };
}
