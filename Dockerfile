FROM oven/bun:1 AS install
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1
WORKDIR /app
ENV NODE_ENV=production
COPY --from=install /app/node_modules ./node_modules
COPY package.json tsconfig.json openapi.json ./
COPY src ./src
COPY db ./db
RUN mkdir -p /app/uploads && chown -R bun:bun /app/uploads
USER bun
CMD ["bun", "run", "start"]
