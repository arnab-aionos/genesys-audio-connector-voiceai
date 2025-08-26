# Genesys Audio Connector for VoiceAI

WebSocket server bridging Genesys Cloud AudioHook with UltraVox AI. Handles real-time audio streaming and protocol translation.

## Quick Start

### Local Development

```bash
git clone <repository-url>
cd genesys-audio-connector-voiceai
npm install
```

Create `.env`:

```bash
# Required
ULTRAVOX_API_KEY=your_ultravox_api_key
SERVER_X_API_KEY=your_secure_api_key

# Optional
PORT=3000
BOT_PROVIDER=UltraVox
NODE_ENV=development
```

Run:

```bash
npm run dev
```

### Production Deployment

1. **Server setup:**

```bash
sudo apt update
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

2. **Deploy:**

```bash
git clone <repository-url>
cd genesys-audio-connector-voiceai
npm ci --production
```

3. **Production .env:**

```bash
# Core
ULTRAVOX_API_KEY=your_production_key
SERVER_X_API_KEY=your_production_auth_key
NODE_ENV=production
PORT=3000

# PM2 Settings (Optional)
APP_NAME=genesys-audio-connector-voiceai
PM2_INSTANCES=1
MAX_MEMORY=500M

# Audio Settings
MAXIMUM_BINARY_MESSAGE_SIZE=64000
MINIMUM_BINARY_MESSAGE_SIZE=1000
NO_INPUT_TIMEOUT=30000
```

4. **Start:**

```bash
npm run build
mkdir -p logs
pm2 start ecosystem.config.js
pm2 save && pm2 startup
```

## API Endpoints

- **Health:** `GET /health`
- **WebSocket:** `ws://localhost:3000/` (requires `X-API-KEY` header)
- **Test:** `POST /test` (with `X-API-KEY` header)

## Scripts

- `npm run dev` - Development with hot reload
- `npm run build` - Build for production
- `npm start` - Run built version

## Monitoring

```bash
pm2 status
pm2 logs genesys-audio-connector
pm2 restart genesys-audio-connector
```

## License

MIT
