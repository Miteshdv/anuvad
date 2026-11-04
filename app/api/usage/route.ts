import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getUsage } from "@/lib/rate-limit";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const usage = await getUsage(session.user.id);
  return NextResponse.json(usage);
}
