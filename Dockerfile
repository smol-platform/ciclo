# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=24-bookworm-slim

FROM node:${NODE_VERSION} AS build
WORKDIR /app

ADD package.json package-lock.json tsconfig.json ./
RUN npm ci

ADD src ./src
ADD tests-ts ./tests-ts
RUN npm run build

FROM node:${NODE_VERSION} AS runtime

LABEL org.opencontainers.image.title="ciclo"
LABEL org.opencontainers.image.description="Ciclo orchestration runner base image"
LABEL org.opencontainers.image.source="https://github.com/smol-platform/ciclo"

ENV NODE_ENV=production
ENV PATH="/root/.local/bin:/usr/local/bin:${PATH}"

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    iproute2 \
    openssh-client \
    wireguard-tools \
  && apt-get clean

RUN curl -fsSL https://herdr.dev/install.sh | sh \
  && if ! command -v herdr >/dev/null 2>&1; then \
    herdr_path="$(find /root -type f -name herdr -perm /111 -print -quit)" \
    && test -n "$herdr_path" \
    && ln -sf "$herdr_path" /usr/local/bin/herdr; \
  fi \
  && herdr --version

WORKDIR /app
ADD package.json package-lock.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force

COPY --from=build /app/dist ./dist
RUN chmod +x \
    /app/dist/src/cli.js \
    /app/dist/src/demo.js \
    /app/dist/src/mcp-http-cli.js \
    /app/dist/src/mcp-stdio-cli.js \
  && ln -s /app/dist/src/cli.js /usr/local/bin/ciclo \
  && ln -s /app/dist/src/demo.js /usr/local/bin/ciclo-demo \
  && ln -s /app/dist/src/mcp-http-cli.js /usr/local/bin/ciclo-mcp-http \
  && ln -s /app/dist/src/mcp-stdio-cli.js /usr/local/bin/ciclo-mcp-stdio

WORKDIR /workspace
ENTRYPOINT ["ciclo"]
CMD ["--help"]
