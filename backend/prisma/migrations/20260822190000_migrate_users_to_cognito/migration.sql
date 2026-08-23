-- Development migration: existing rows receive explicit UNMAPPED identifiers.
-- They cannot authenticate with Cognito and must be reseeded or deliberately
-- remapped to real Cognito subjects/usernames before use.
ALTER TABLE "User"
ADD COLUMN "cognitoSub" TEXT,
ADD COLUMN "cognitoUsername" TEXT;

UPDATE "User"
SET "cognitoSub" = 'UNMAPPED_DEV_SUB_' || "id"::text,
    "cognitoUsername" = 'UNMAPPED_DEV_USERNAME_' || "id"::text;

ALTER TABLE "User"
ALTER COLUMN "cognitoSub" SET NOT NULL,
ALTER COLUMN "cognitoUsername" SET NOT NULL,
DROP COLUMN "passwordHash";

CREATE UNIQUE INDEX "User_cognitoSub_key" ON "User"("cognitoSub");
CREATE UNIQUE INDEX "User_cognitoUsername_key" ON "User"("cognitoUsername");
