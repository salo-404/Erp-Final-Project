// The Prisma CLI does not auto-load .env the way main.ts does - load it
// explicitly so env('DATABASE_URL') below can actually resolve for local
// `prisma migrate`/`db push`/`studio` runs. Real deployments (ECS) supply
// DATABASE_URL as a real environment variable already, so this is a no-op
// there (dotenv never overrides an already-set variable).
import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

// Prisma 7 no longer allows a datasource url in schema.prisma at all (see
// that file's own datasource block) - the app's own runtime PrismaClient
// is always constructed with an explicit @prisma/adapter-pg connection
// (see prisma.service.ts), which never consults this config. This file
// exists only so CLI commands (migrate deploy/status, db push, studio)
// have a real datasource url to work with.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
  },
});
