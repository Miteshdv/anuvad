const SILENT_AUDIO =
  "data:audio/wav;base64,UklGRuwAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YcgAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==";

const BLOCKED_MESSAGE =
  "Audio playback was blocked by your browser. Use Replay latest or the play button to try again, and allow sound for this site.";

type PlaybackOptions = {
  text: string;
  lang: string;
  gender: "default" | "female" | "male";
};

type PlaybackEvents = {
  onSpeakingChange: (speaking: boolean) => void;
  onError: (message: string | null) => void;
};

export class TtsPlayback {
  private audio: HTMLAudioElement | null = null;
  private url: string | null = null;
  private controller: AbortController | null = null;
  private blocked = false;
  private generation = 0;
  private preparing: Promise<void> | null = null;
  private readonly events: PlaybackEvents;

  constructor(events: PlaybackEvents) {
    this.events = events;
  }

  private getAudio() {
    if (!this.audio) {
      this.audio = new Audio();
      this.audio.setAttribute("playsinline", "");
    }
    return this.audio;
  }

  private reset(preservePreparation = false) {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    this.blocked = false;
    if (preservePreparation && this.preparing) {
      if (this.url) URL.revokeObjectURL(this.url);
      this.url = null;
      return;
    }
    this.preparing = null;
    if (this.audio) {
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.pause();
      this.audio.removeAttribute("src");
    }
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }

  // Call synchronously from a user gesture. Reusing the element retains its media permission.
  unlock() {
    if (this.controller || this.preparing) return;
    const audio = this.getAudio();
    audio.src = SILENT_AUDIO;
    try {
      const preparation = audio.play().catch(() => {}).finally(() => {
        if (this.preparing === preparation) this.preparing = null;
      });
      this.preparing = preparation;
    } catch {
      this.preparing = null;
    }
  }

  stop() {
    this.reset();
    this.events.onSpeakingChange(false);
  }

  dispose() {
    this.reset();
    this.audio = null;
  }

  async speak({ text, lang, gender }: PlaybackOptions) {
    if (!text.trim()) return;
    this.reset(true);
    this.events.onSpeakingChange(false);
    this.events.onError(null);
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const current = () => generation === this.generation && !controller.signal.aborted;

    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, lang, gender }),
        signal: controller.signal,
      });
      if (!current()) return;

      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        if (current()) {
          this.reset();
          this.events.onError(payload?.error ?? `TTS failed (${res.status})`);
        }
        return;
      }

      const blob = await res.blob();
      if (!current()) return;
      const preparation = this.preparing;
      if (preparation) await preparation;
      if (!current()) return;
      this.url = URL.createObjectURL(blob);
      const audio = this.getAudio();
      audio.src = this.url;
      audio.onended = () => {
        if (current()) {
          this.reset();
          this.events.onSpeakingChange(false);
        }
      };
      audio.onerror = () => {
        if (current()) {
          this.reset();
          this.events.onSpeakingChange(false);
          this.events.onError("Could not play audio. Use the play button to try again.");
        }
      };

      await audio.play();
      if (current()) this.events.onSpeakingChange(true);
    } catch (error) {
      if (!current()) return;
      if (error instanceof Error && error.name === "NotAllowedError") {
        this.blocked = true;
        this.events.onError(BLOCKED_MESSAGE);
      } else {
        this.reset();
        this.events.onError(error instanceof Error ? error.message : "TTS failed");
      }
      this.events.onSpeakingChange(false);
    }
  }

  // A blocked recording is retained so replay can call play() directly in a click handler.
  replay() {
    if (!this.blocked || !this.url || !this.audio || !this.controller) return false;
    this.blocked = false;
    const audio = this.audio;
    const generation = this.generation;
    const controller = this.controller;
    this.events.onError(null);
    try {
      void audio.play().then(() => {
        if (generation === this.generation && this.controller === controller) this.events.onSpeakingChange(true);
      }).catch((error: unknown) => {
        if (generation !== this.generation || this.controller !== controller) return;
        this.events.onSpeakingChange(false);
        if (error instanceof Error && error.name === "NotAllowedError") {
          this.blocked = true;
          this.events.onError(BLOCKED_MESSAGE);
        } else {
          this.reset();
          this.events.onError(error instanceof Error ? error.message : "Could not play audio.");
        }
      });
    } catch (error) {
      this.events.onSpeakingChange(false);
      if (error instanceof Error && error.name === "NotAllowedError") {
        this.blocked = true;
        this.events.onError(BLOCKED_MESSAGE);
      } else {
        this.reset();
        this.events.onError(error instanceof Error ? error.message : "Could not play audio.");
      }
    }
    return true;
  }
}
