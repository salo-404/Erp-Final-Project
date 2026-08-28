import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types';
import {
  fromLoginCredentials,
  fromNodeProviderChain,
} from '@aws-sdk/credential-providers';

/**
 * Uses the standard AWS credential chain in production, with AWS CLI
 * `aws login` credentials as a local-development fallback.
 */
export function createAwsCredentialProvider(): AwsCredentialIdentityProvider {
  const standardProvider = fromNodeProviderChain();
  const loginProvider = fromLoginCredentials({
    configFilepath:
      process.env.AWS_CONFIG_FILE ?? join(homedir(), '.aws', 'config'),
  });

  return async () => {
    try {
      return await standardProvider();
    } catch {
      return loginProvider();
    }
  };
}
