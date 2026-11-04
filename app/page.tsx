import { Suspense } from "react";
import SignInPanel from "./SignInPanel";
import styles from "./landing.module.css";

export default function Home({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>;
}) {
  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <span className={styles.badge}>Anuvad</span>
        <h1 className={styles.title}>Speak. Translate. Understand.</h1>
        <p className={styles.subtitle}>
          Real-time speech translation between ten languages, powered by your browser&apos;s
          microphone and Google Translate.
        </p>

        <Suspense fallback={<div className={styles.buttonFallback} />}>
          <SignInPanel searchParams={searchParams} />
        </Suspense>

        <ul className={styles.features}>
          <li>Push-to-talk speech recognition</li>
          <li>Instant translation with natural voice playback</li>
          <li>Email yourself the full transcript</li>
        </ul>

        <p className={styles.note}>
          Best experienced in Chrome or Edge. Microphone access is required.
        </p>
      </div>
    </main>
  );
}
