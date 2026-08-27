import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { UserRole } from '../../../generated/prisma/enums';

export interface AuthenticatedUser {
  id: number;
  email: string;
  role: UserRole;
  /**
   * True only when the verified Cognito access token's client_id is the
   * SERVICE app client (COGNITO_SERVICE_APP_CLIENT_ID) - set by
   * JwtAuthGuard from the token itself, never from the User row (role is
   * shared with ordinary EMPLOYEE accounts and cannot distinguish the AI
   * service identity on its own). Gates AiServiceGuard-protected routes
   * such as POST /ai/query-database.
   */
  isAiService: boolean;
}

interface RequestWithUser {
  user: AuthenticatedUser;
}

/**
 * The database-backed identity attached after Cognito verification by JwtAuthGuard.
 * Only usable on routes that already run JwtAuthGuard — pulling `req.user`
 * this way is how every route that needs "who is making this request"
 * (e.g. adjustInventory's requestedBy, document review's reviewedById)
 * gets that identity, instead of trusting a client-supplied field.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest<RequestWithUser>();
    return request.user;
  },
);
