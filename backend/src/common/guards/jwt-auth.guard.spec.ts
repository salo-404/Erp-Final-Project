import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { UserRole } from '../../../generated/prisma/enums';
import { CognitoTokenVerifier } from '../../auth/cognito-token-verifier.service';
import { JwtAuthGuard } from './jwt-auth.guard';

function contextFor(request: Record<string, unknown>) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as ExecutionContext;
}

// Real bug this exposed, not hypothetical: importing JwtAuthGuard
// transitively loads PrismaService, whose module has `import
// 'dotenv/config'` as a side effect - the very first test file to import
// it in a given Jest worker silently pulls in a developer's real local
// backend/.env, including LOCAL_AUTH_MODE=true if they have local dev
// auth enabled (see jwt-auth.guard.ts's own LOCAL_AUTH_MODE branch), and
// that leaks across every other test in the same worker for the rest of
// the run. These tests must exercise the REAL Cognito path regardless of
// what's in anyone's local .env, so LOCAL_AUTH_MODE is forced off here
// unconditionally, restored after each test.
describe('JwtAuthGuard Cognito authentication', () => {
  const ORIGINAL_LOCAL_AUTH_MODE = process.env.LOCAL_AUTH_MODE;

  beforeEach(() => {
    delete process.env.LOCAL_AUTH_MODE;
  });

  afterEach(() => {
    process.env.LOCAL_AUTH_MODE = ORIGINAL_LOCAL_AUTH_MODE;
  });

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

describe('JwtAuthGuard LOCAL_AUTH_MODE bypass', () => {
  const ORIGINAL_LOCAL_AUTH_MODE = process.env.LOCAL_AUTH_MODE;

  afterEach(() => {
    process.env.LOCAL_AUTH_MODE = ORIGINAL_LOCAL_AUTH_MODE;
  });

  it('logs in as the real seeded user matching the local: token, never calling Cognito', async () => {
    process.env.LOCAL_AUTH_MODE = 'true';
    const verifier = { verify: jest.fn().mockRejectedValue(new Error('must not be called')) };
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1,
          email: 'admin@minierp.demo',
          role: UserRole.ADMIN,
        }),
      },
    };
    const request = { headers: { authorization: 'Bearer local:admin@minierp.demo' } };
    const guard = new JwtAuthGuard({
      get: (type: unknown) => (type === CognitoTokenVerifier ? verifier : prisma),
    } as never);

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(verifier.verify).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'admin@minierp.demo' },
      select: { id: true, email: true, role: true },
    });
    expect(request).toHaveProperty('user.role', UserRole.ADMIN);
    expect(request).toHaveProperty('user.isAiService', false);
  });

  it('rejects a bearer value that is not the local: scheme', async () => {
    process.env.LOCAL_AUTH_MODE = 'true';
    const prisma = { user: { findUnique: jest.fn() } };
    const guard = new JwtAuthGuard({ get: () => prisma } as never);

    await expect(
      guard.canActivate(
        contextFor({ headers: { authorization: 'Bearer some-real-looking-jwt' } }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a local: token for an email with no matching seeded user', async () => {
    process.env.LOCAL_AUTH_MODE = 'true';
    const prisma = { user: { findUnique: jest.fn().mockResolvedValue(null) } };
    const guard = new JwtAuthGuard({ get: () => prisma } as never);

    await expect(
      guard.canActivate(
        contextFor({ headers: { authorization: 'Bearer local:nobody@example.com' } }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
