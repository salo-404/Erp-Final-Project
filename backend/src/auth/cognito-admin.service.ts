import { Injectable } from '@nestjs/common';
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { randomUUID } from 'node:crypto';

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
    const result = await this.client.send(
      new AdminCreateUserCommand({
        UserPoolId: this.userPoolId,
        Username: username,
        DesiredDeliveryMediums: ['EMAIL'],
        UserAttributes: [
          { Name: 'email', Value: input.email },
          { Name: 'name', Value: input.name },
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
    return { cognitoSub, cognitoUsername };
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
