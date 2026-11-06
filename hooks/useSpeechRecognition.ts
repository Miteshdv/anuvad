"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { encodeWav } from "@/lib/wav";

const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const MAX_PENDING = 6;

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
    () => typeof navigator.mediaDevices?.getUserMedia === "function" && typeof AudioContext !== "undefined" && typeof AudioWorkletNode !== "undefined", () => true);
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
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined" || typeof AudioWorkletNode === "undefined") {
      setError("Microphone recording is unavailable. Use an up-to-date browser over HTTPS (or localhost).");
      return;
    }
    let capturing = true;
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let processor: AudioWorkletNode | null = null;
    let stopTimer: number | undefined;
    let segmentAudioEpoch = getAudioEpochRef.current?.();
    let activeRequests = 0;
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
    const releaseAudio = () => {
      clearTimer(stopTimer);
      if (processor) processor.port.onmessage = null;
      source?.disconnect();
      processor?.disconnect();
      if (context) void context.close().catch(() => {});
      processor = null;
      source = null;
      context = null;
      releaseMic();
    };
    const stopCapture = (commit: boolean) => {
      const wasCapturing = capturing;
      capturing = false;
      session.capturing = false;
      if (!commit) {
        session.valid = false;
        controllers.forEach((controller) => controller.abort());
        timers.forEach((id) => window.clearTimeout(id));
        timers.clear();
        jobs.length = 0;
        releaseAudio();
      } else if (wasCapturing) {
        if (processor) {
          stopTimer = later(() => fail("The browser could not finish recording the final audio segment."), 2000);
          processor.port.postMessage({ type: "stop" });
          releaseMic();
        } else {
          session.valid = false;
          releaseAudio();
        }
      }
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
        form.append("file", job.audio, "segment.wav");
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
        context = new AudioContext();
        await context.audioWorklet.addModule("/pcm-recorder.js");
        if (!live() || !capturing) return;
        source = context.createMediaStreamSource(acquired);
        processor = new AudioWorkletNode(context, "pcm-recorder", { numberOfInputs: 1, numberOfOutputs: 1 });
        const sampleRate = context.sampleRate;
        processor.port.onmessage = ({ data }: MessageEvent<{ type: string; samples?: Float32Array }>) => {
          if (!live()) return;
          if (data.type === "stopped") {
            releaseAudio();
            updateDraft();
            return;
          }
          if (data.type !== "segment" || !data.samples?.length) return;
          const audio = encodeWav(data.samples, sampleRate);
          if (audio.size > MAX_AUDIO_BYTES) {
            fail("Recorded audio exceeded the segment size limit. Start listening again.");
            return;
          }
          if (jobs.length >= MAX_PENDING) {
            fail("Transcription cannot keep up with recording. Pending audio was discarded. Check your connection and start listening again.");
            return;
          }
          jobs.push({ audio, audioEpoch: segmentAudioEpoch, done: false, started: false });
          segmentAudioEpoch = getAudioEpochRef.current?.();
          pump();
        };
        processor.onprocessorerror = () => fail("Microphone audio processing failed. Start listening again.");
        source.connect(processor);
        // The processor outputs silence; connecting it keeps capture active without microphone feedback.
        processor.connect(context.destination);
        await context.resume();
        if (!live() || !capturing) return;
        updateDraft();
      } catch (cause) {
        const name = cause instanceof Error ? cause.name : "";
        fail(name === "NotAllowedError" || name === "SecurityError"
          ? "Microphone permission was denied or blocked. Allow microphone access in your browser settings."
          : "Could not start microphone audio capture. Check microphone access and try again.");
      }
    })();
  };

  const stop = (commit = true) => { sessionRef.current?.stop(commit); };
  const reset = () => { stop(false); setInterim(""); setError(null); };
  return { supported, listening, interim, error, start, stop, reset };
}
