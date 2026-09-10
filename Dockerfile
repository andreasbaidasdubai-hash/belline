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

FROM node:22-slim AS run
WORKDIR /app
ENV NODE_ENV=production
# The book lives on a mounted volume; the container filesystem is wiped on
# every deploy.
ENV DATA_DIR=/data

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY package.json next.config.mjs tsconfig.json server.ts ./
COPY src ./src

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000
CMD ["node", "--import", "tsx", "server.ts", "--prod"]
