import { prisma } from "@/lib/prisma";

export const DAILY_LIMIT = 50;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export type RateLimitResult = { allowed: boolean; used: number; limit: number };

export async function checkAndIncrementUsage(userId: string): Promise<RateLimitResult> {
  const day = todayUtc();
  const row = await prisma().usageCounter.upsert({
    where: { userId_day: { userId, day } },
    create: { userId, day, count: 1 },
    update: { count: { increment: 1 } },
  });
  return { allowed: row.count <= DAILY_LIMIT, used: row.count, limit: DAILY_LIMIT };
}

export async function getUsage(userId: string): Promise<RateLimitResult> {
  const row = await prisma().usageCounter.findUnique({
    where: { userId_day: { userId, day: todayUtc() } },
  });
  return {
    allowed: (row?.count ?? 0) < DAILY_LIMIT,
    used: row?.count ?? 0,
    limit: DAILY_LIMIT,
  };
}
