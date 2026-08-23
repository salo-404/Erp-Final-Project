// Test-only placeholders let AppModule construct Cognito providers before each
// suite overrides token verification. Ordinary E2E tests never contact Cognito.
process.env.AWS_REGION = 'eu-west-1';
process.env.AWS_S3_BUCKET = 'invoice-documents-mini-erp';
process.env.COGNITO_USER_POOL_ID = 'eu-west-1_e2eTestPool';
process.env.COGNITO_APP_CLIENT_ID = 'e2e-test-app-client';
process.env.COGNITO_SERVICE_APP_CLIENT_ID = 'e2e-test-service-app-client';
process.env.AWS_ACCESS_KEY_ID = 'e2e-test-access-key';
process.env.AWS_SECRET_ACCESS_KEY = 'e2e-test-secret-key';
