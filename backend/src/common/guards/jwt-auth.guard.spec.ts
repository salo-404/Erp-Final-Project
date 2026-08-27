import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { UserRole } from '../../../generated/prisma/enums';
import { CognitoTokenVerifier } from '../../auth/cognito-token-verifier.service';
import { JwtAuthGuard } from './jwt-auth.guard';

function contextFor(request: Record<string, unknown>) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as ExecutionContext;
}

describe('JwtAuthGuard Cognito authentication', () => {
  it('maps a valid access-token subject to the database user and DB role', async () => {
    const verifier = { verify: jest.fn().mockResolvedValue({ sub: 'cognito-sub', role: 'ADMIN' }) };
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 7,
          email: 'employee@example.com',
          role: UserRole.EMPLOYEE,
        }),
      },
    };
    const request = { headers: { authorization: 'Bearer valid-access-token' } };
    const guard = new JwtAuthGuard({
      get: (type: unknown) => (type === CognitoTokenVerifier ? verifier : prisma),
    } as never);

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { cognitoSub: 'cognito-sub' },
      select: { id: true, email: true, role: true },
    });
    expect(request).toHaveProperty('user.role', UserRole.EMPLOYEE);
    expect(request).toHaveProperty('user.isAiService', false);
  });

  it('marks isAiService true only when the token was issued to the service app client', async () => {
    const originalServiceClientId = process.env.COGNITO_SERVICE_APP_CLIENT_ID;
    process.env.COGNITO_SERVICE_APP_CLIENT_ID = 'service-client-id';
    try {
      const verifier = {
        verify: jest.fn().mockResolvedValue({ sub: 'ai-service-sub', client_id: 'service-client-id' }),
      };
      const prisma = {
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: 3,
            email: 'ai-agent@internal.local',
            role: UserRole.EMPLOYEE,
          }),
        },
      };
      const request = { headers: { authorization: 'Bearer service-token' } };
      const guard = new JwtAuthGuard({
        get: (type: unknown) => (type === CognitoTokenVerifier ? verifier : prisma),
      } as never);

      await guard.canActivate(contextFor(request));

      expect(request).toHaveProperty('user.isAiService', true);
    } finally {
      process.env.COGNITO_SERVICE_APP_CLIENT_ID = originalServiceClientId;
    }
  });

  it.each(['invalid signature', 'expired', 'wrong client', 'wrong pool', 'wrong token type'])(
    'rejects verifier failure: %s',
    async () => {
      const verifier = { verify: jest.fn().mockRejectedValue(new Error('verification failed')) };
      const prisma = { user: { findUnique: jest.fn() } };
      const guard = new JwtAuthGuard({
        get: (type: unknown) => (type === CognitoTokenVerifier ? verifier : prisma),
      } as never);
      await expect(
        guard.canActivate(
          contextFor({ headers: { authorization: 'Bearer rejected-token' } }),
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    },
  );

  it('rejects a valid Cognito subject with no ERP mapping', async () => {
    const verifier = { verify: jest.fn().mockResolvedValue({ sub: 'unmapped' }) };
    const prisma = { user: { findUnique: jest.fn().mockResolvedValue(null) } };
    const guard = new JwtAuthGuard({
      get: (type: unknown) => (type === CognitoTokenVerifier ? verifier : prisma),
    } as never);
    await expect(
      guard.canActivate(contextFor({ headers: { authorization: 'Bearer valid' } })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
