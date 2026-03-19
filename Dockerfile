# Use official Bun image
FROM oven/bun:alpine

# Set working directory
WORKDIR /app

# Copy dependency files first (better caching)
COPY package.json bun.lockb ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy the rest of the app
COPY . .

# Next.js dev server port
EXPOSE 3000

# Enable reliable hot reload in Docker
# ENV NODE_ENV=development
ENV NODE_ENV=development \
    CHOKIDAR_USEPOLLING=true \
    WATCHPACK_POLLING=true

# Run Next.js in dev mode
CMD ["bun", "run", "dev"]