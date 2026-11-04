import { io } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { signOutAction } from "@/app/actions";

export default async function UserBadge() {
  await io();
  const session = await auth();
  if (!session?.user?.id) redirect("/");

  return (
    <div className="headerRight">
      {session.user.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="avatar" src={session.user.image} alt="" width={32} height={32} />
      ) : null}
      <span className="userName">{session.user.name ?? session.user.email}</span>
      <form action={signOutAction}>
        <button type="submit" className="ghostButton">
          Sign out
        </button>
      </form>
    </div>
  );
}
