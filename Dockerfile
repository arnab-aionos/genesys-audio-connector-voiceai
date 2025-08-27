FROM node:20-alpine
WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./
RUN npm ci --only=production

# Copy source and build
COPY . .
RUN npm run build

# Remove dev dependencies and source files
RUN rm -rf src/ node_modules/
RUN npm ci --only=production

EXPOSE 5000
CMD ["node", "dist/index.js"]