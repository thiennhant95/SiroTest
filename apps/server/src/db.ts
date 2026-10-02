import { PrismaClient } from '@prisma/client';

let prisma: PrismaClient | undefined;

export function db(): PrismaClient {
  if (!prisma) prisma = new PrismaClient();
  return prisma;
}
