# Deployment image for agentcore_entrypoint.py on AWS Bedrock AgentCore
# Runtime. AgentCore Runtime requires ARM64 containers - the --platform flag
# below is set explicitly rather than relying on the host's native
# architecture, so this builds correctly for ARM64 even from an x86 build
# machine (via QEMU emulation - `docker buildx build --platform linux/arm64
# -t <tag> --load .`). BuildKit's linter flags a hardcoded --platform
# constant as a style warning (it usually prefers the platform be passed on
# the build command instead, for multi-platform portability) - deliberately
# kept here anyway: this image has exactly one valid target (AgentCore's
# ARM64 requirement), so hardcoding it means a build that forgets the CLI
# --platform flag still produces a working image instead of silently
# producing an amd64 one AgentCore Runtime can't run.
FROM --platform=linux/arm64 python:3.11-slim

# Unbuffered stdout/stderr so logs (including BedrockAgentCoreApp's own
# request logging) show up immediately in `docker logs` / CloudWatch instead
# of being buffered until the process exits.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# Install dependencies in their own layer, before copying the rest of the
# source, so a code-only change doesn't invalidate the pip install cache.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the project. What's excluded (.env, __pycache__, .git,
# tests/, etc.) is controlled by .dockerignore, not listed here - this
# picks up agents/, tools/, config/, narration/, scripts/, and
# agentcore_entrypoint.py in one step, matching every import
# agentcore_entrypoint.py's dependency chain needs.
COPY . .

# BedrockAgentCoreApp (agentcore_entrypoint.py) serves /invocations and
# /ping on this port itself - AgentCore Runtime's required contract. Do not
# add those routes here; the SDK already provides them.
EXPOSE 8080

# No .env, API keys, or credentials are baked into this image. Every
# setting config/settings.py reads (MODEL_PROVIDER, OPENAI_API_KEY,
# AWS_REGION, BEDROCK_MODEL_ID, etc.) comes from environment
# variables supplied at deploy/run time - e.g. `docker run -e
# MODEL_PROVIDER=bedrock ...` locally, or the AgentCore Runtime
# deployment's own environment configuration in AWS - exactly like local
# development already works via .env + python-dotenv, just sourced from
# the container's environment instead of a file.
CMD ["python", "agentcore_entrypoint.py"]
