FROM node:22-bookworm-slim

ENV CI=true

# Listen on the container's network so the tunnel container can reach the game.
# No port is published in compose.yaml, so nothing outside Docker can.
ENV LISTEN_HOST=0.0.0.0

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN corepack enable
RUN corepack prepare pnpm@11.17.0 --activate

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm build

EXPOSE 3000

CMD ["pnpm", "start"]