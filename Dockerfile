FROM node:20-alpine
WORKDIR /app

RUN apk add --no-cache tzdata
ENV TZ=Asia/Kolkata

# Copy package files first for better caching
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# Remove dev dependencies and source files
RUN rm -rf src/
RUN npm ci --only=production

EXPOSE 5000
CMD ["node", "dist/index.js"]