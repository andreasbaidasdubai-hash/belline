# Belline runs as a long-lived process, not a serverless function — the
# voice bridge holds websockets open for the length of a call. This image
# works on Railway, Fly, Render, or any container host.

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:22-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build
# The marketing site ships in the same image. It was on a separate static
# host until that host's build allowance ran out and quietly stopped
# publishing — the site stayed up, frozen, while every push was accepted by
# git and ignored. One process serves both now, chosen by hostname.
RUN npm run site

FROM node:22-slim AS run
WORKDIR /app
ENV NODE_ENV=production
# The book lives on a mounted volume; the container filesystem is wiped on
# every deploy.
ENV DATA_DIR=/data

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/site ./site
COPY package.json next.config.mjs tsconfig.json server.ts ./
COPY src ./src

# The directory is created here, but the persistent disk is attached by the
# host. Railway rejects a Dockerfile VOLUME outright, and on Fly or Render it
# would be shadowed by the real mount anyway.
RUN mkdir -p /data

EXPOSE 3000
CMD ["node", "--import", "tsx", "server.ts", "--prod"]
