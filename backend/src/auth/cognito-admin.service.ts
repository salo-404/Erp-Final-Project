import { Injectable } from '@nestjs/common';
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { randomBytes, randomUUID } from 'node:crypto';

@Injectable()
export class CognitoAdminService {
  private readonly userPoolId: string;
  private readonly client: CognitoIdentityProviderClient;

  constructor() {
    const userPoolId = process.env.COGNITO_USER_POOL_ID;
    if (!userPoolId) throw new Error('COGNITO_USER_POOL_ID is required');
    this.userPoolId = userPoolId;
    this.client = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION });
  }

  async createUser(input: { name: string; email: string }) {
    const username = `erp-${randomUUID()}`;
    const temporaryPassword = this.generateTemporaryPassword();
    const result = await this.client.send(
      new AdminCreateUserCommand({
        UserPoolId: this.userPoolId,
        Username: username,
        TemporaryPassword: temporaryPassword,
        // The application sends the onboarding message through its existing
        // Gmail integration so delivery failure is part of provisioning.
        MessageAction: 'SUPPRESS',
        UserAttributes: [
          { Name: 'email', Value: input.email },
          { Name: 'name', Value: input.name },
          // Required for the pool's email alias (AliasAttributes) to
          // resolve at all - an unverified email attribute is never
          // registered as a usable sign-in alias, so without this every
          // admin-created user would be permanently unable to sign in
          // with their email (only the opaque erp-<uuid> Cognito
          // username would work). There's no self-service email
          // verification flow in this app, and the admin is trusted to
          // enter a real employee's address, so pre-verifying is correct
          // here rather than leaving it false.
          { Name: 'email_verified', Value: 'true' },
        ],
      }),
    );
    const cognitoSub = result.User?.Attributes?.find(
      (attribute) => attribute.Name === 'sub',
    )?.Value;
    const cognitoUsername = result.User?.Username ?? username;
    if (!cognitoSub) {
      await this.deleteUser(cognitoUsername);
      throw new Error('Cognito did not return a user subject');
    }
    return { cognitoSub, cognitoUsername, temporaryPassword };
  }

  private generateTemporaryPassword(): string {
    // Includes every standard Cognito character class and 144 bits of
    // cryptographic randomness. Cognito remains authoritative and rejects it
    // if the deployed pool has a stricter policy.
    return `Aa1!${randomBytes(18).toString('base64url')}`;
  }

  async updateUser(username: string, input: { name?: string; email?: string }) {
    const attributes = [
      ...(input.name !== undefined ? [{ Name: 'name', Value: input.name }] : []),
      ...(input.email !== undefined ? [{ Name: 'email', Value: input.email }] : []),
    ];
    if (!attributes.length) return;
    await this.client.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: this.userPoolId,
        Username: username,
        UserAttributes: attributes,
      }),
    );
  }

  async deleteUser(username: string) {
    await this.client.send(
      new AdminDeleteUserCommand({ UserPoolId: this.userPoolId, Username: username }),
    );
  }
}
