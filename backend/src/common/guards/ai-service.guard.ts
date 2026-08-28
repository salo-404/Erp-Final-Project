import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../decorators/current-user.decorator';

/**
 * Restricts a route to the AI service Cognito identity only - must run
 * AFTER JwtAuthGuard (which is what actually verifies the token and sets
 * request.user.isAiService from its client_id claim; see JwtAuthGuard).
 * A real, authenticated human user - even an ADMIN - is rejected here,
 * since isAiService is derived from which Cognito APP CLIENT issued the
 * token, not from the user's role.
 */
@Injectable()
export class AiServiceGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();

    if (!request.user?.isAiService) {
      throw new ForbiddenException(
        'This endpoint is restricted to the AI service identity',
      );
    }
    return true;
  }
}
