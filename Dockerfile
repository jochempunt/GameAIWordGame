FROM node:22-bookworm-slim

ENV CI=true

# Listen on the container's network so the tunnel container can reach the game.
# No port is published in compose.yaml, so nothing outside Docker can.
ENV LISTEN_HOST=0.0.0.0

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends python3-venv libgomp1 && rm -rf /var/lib/apt/lists/*
COPY ml/humor/requirements.txt /tmp/humor-requirements.txt
RUN python3 -m venv /opt/humor-venv && /opt/humor-venv/bin/pip install --no-cache-dir -r /tmp/humor-requirements.txt
ENV HUMOR_PYTHON=/opt/humor-venv/bin/python

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN corepack enable
RUN corepack prepare pnpm@11.17.0 --activate

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm build

EXPOSE 3000

CMD ["pnpm", "start"]
