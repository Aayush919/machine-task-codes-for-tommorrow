import { Prisma, PrismaClient } from '@prisma/client'

export const prisma = new PrismaClient()

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect()
}
