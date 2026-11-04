import { io } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { signInWithGoogle } from "./actions";
import styles from "./landing.module.css";
import GoogleMark from "./GoogleMark";

export default async function SignInPanel({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>;
}) {
  await io();
  const session = await auth();
  if (session?.user) redirect("/translate");

  const { callbackUrl } = await searchParams;

  return (
    <form action={signInWithGoogle}>
      <input type="hidden" name="callbackUrl" value={callbackUrl ?? "/translate"} />
      <button type="submit" className={styles.googleButton}>
        <GoogleMark />
        Continue with Google
      </button>
    </form>
  );
}
