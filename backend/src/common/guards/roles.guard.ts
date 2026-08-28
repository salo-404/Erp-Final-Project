import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '../../../generated/prisma/enums';
import { ROLES_KEY } from '../decorators/roles.decorator';

interface AuthenticatedRequest {
  user?: {
    id: number;
    email: string;
    role: UserRole;
  };
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const { user } = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest>();

    // ADMIN has full ERP access per the project's role policy (Backend-Team-Split.md /
    // Salman-Backend-Plan.md): ADMIN can reach anything an EMPLOYEE-restricted endpoint
    // allows, in addition to ADMIN-only endpoints. EMPLOYEE must match the declared
    // @Roles() list exactly.
    const allowed =
      !!user && (requiredRoles.includes(user.role) || user.role === UserRole.ADMIN);

    if (!allowed) {
      throw new ForbiddenException('Insufficient role');
    }

    return true;
  }
}
