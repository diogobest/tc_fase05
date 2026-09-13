FROM oven/bun:1
WORKDIR /api

COPY . .
RUN mkdir -p /api/uploads && chown -R bun:bun /api/uploads
RUN bun install
CMD ["bun", "run", "start"]
