"use server";

import { signIn, signOut } from "@/lib/auth";

export async function signInWithGoogle(formData: FormData) {
  const callbackUrl = formData.get("callbackUrl");
  const safeRedirect =
    typeof callbackUrl === "string" && callbackUrl.startsWith("/") && !callbackUrl.startsWith("//")
      ? callbackUrl
      : "/translate";
  await signIn("google", { redirectTo: safeRedirect });
}

export async function signOutAction() {
  await signOut({ redirectTo: "/" });
}
