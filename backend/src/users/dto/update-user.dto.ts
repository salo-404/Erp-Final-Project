import { IsEnum } from 'class-validator';
import { UserRole } from '../../../generated/prisma/enums';

/**
 * Backs the admin Employee Management "change role" action ONLY —
 * deliberately just this one field. name/email/password and Cognito
 * identity fields (cognitoSub/cognitoUsername) are never editable through
 * this endpoint: those are auth-identity fields, not role/permission
 * fields, and this DTO's shape is what makes that impossible to bypass
 * from the client rather than just a UI convention.
 */
export class UpdateUserDto {
  @IsEnum(UserRole)
  role: UserRole;
}
