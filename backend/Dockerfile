# Deployment image for the NestJS backend on ECS/Fargate, behind
# mini-erp-alb -> mini-erp-backend-tg (port 3000).
#
# Multi-stage: the builder stage installs full (dev+prod) dependencies,
# generates the Prisma client (see prisma/schema.prisma's binaryTargets -
# debian-openssl-3.0.x matches this image's base, not the dev machine's),
# and compiles TypeScript; the runtime stage reinstalls only production
# dependencies and copies over just the compiled output + generated
# Prisma client, so the final image doesn't carry devDependencies,
# TypeScript sources, or the build toolchain.
# node:22-slim has no openssl CLI installed, and Prisma's query engine
# needs to detect the real libssl version to pick the matching binary
# target (see schema.prisma's binaryTargets) - without this, Prisma
# silently defaults to a GUESSED engine (confirmed live: "Prisma failed to
# detect the libssl/openssl version... Defaulting to openssl-1.1.x", which
# does not match this image's actual OpenSSL 3.x, and the query engine
# then failed at runtime in a way that surfaced as an unrelated-looking
# generic auth error, not an obvious startup crash).
FROM node:22-slim AS builder
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig*.json nest-cli.json ./
COPY prisma ./prisma
COPY src ./src
RUN npx prisma generate
RUN npm run build

FROM node:22-slim AS runtime
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/generated ./generated
COPY prisma ./prisma
COPY prisma.config.ts ./

# No .env or credentials are baked into this image - every setting
# (DATABASE_URL, AWS_REGION, COGNITO_*, etc.) comes from real environment
# variables supplied at deploy/run time (the ECS task definition's own
# environment/secrets configuration), exactly like local development
# already works via .env + dotenv, just sourced from the container's
# environment instead of a file.

EXPOSE 3000
CMD ["node", "dist/src/main"]
