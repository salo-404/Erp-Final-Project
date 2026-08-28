import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AiServiceGuard } from './ai-service.guard';

function contextFor(request: Record<string, unknown>) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as ExecutionContext;
}

describe('AiServiceGuard', () => {
  const guard = new AiServiceGuard();

  it('allows a request whose user.isAiService is true', () => {
    const request = { user: { id: 3, email: 'ai-agent@internal.local', role: 'EMPLOYEE', isAiService: true } };
    expect(guard.canActivate(contextFor(request))).toBe(true);
  });

  it('rejects a real human user, even an ADMIN, whose token was not issued to the service client', () => {
    const request = { user: { id: 1, email: 'admin@minierp.demo', role: 'ADMIN', isAiService: false } };
    expect(() => guard.canActivate(contextFor(request))).toThrow(ForbiddenException);
  });

  it('rejects when no user is attached at all', () => {
    expect(() => guard.canActivate(contextFor({}))).toThrow(ForbiddenException);
  });
});
