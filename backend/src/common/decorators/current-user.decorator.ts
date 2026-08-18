import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { UserRole } from '../../../generated/prisma/enums';

export interface AuthenticatedUser {
  id: number;
  email: string;
  role: UserRole;
}

interface RequestWithUser {
  user: AuthenticatedUser;
}

/**
 * The authenticated identity attached by JwtAuthGuard (via JwtStrategy.validate()).
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
