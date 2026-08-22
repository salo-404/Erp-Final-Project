import { PrismaService } from '../src/prisma/prisma.service';

export const mockCognitoVerifier = {
  verify: async (token: string) => ({ sub: token }),
};

export async function cognitoAuthHeaderFor(prisma: PrismaService, email: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  return `Bearer ${user.cognitoSub}`;
}
