import dotenv from "dotenv";
import path from "path";

console.log("=== Environment Loading ===");
console.log("Working directory:", process.cwd());

const envPath = path.resolve(process.cwd(), ".env");
console.log("Loading .env from:", envPath);

const envResult = dotenv.config({ path: envPath });

if (envResult.error) {
  console.error("❌ Failed to load .env file:", envResult.error);
  process.exit(1);
}

const envCount = Object.keys(envResult.parsed || {}).length;
console.log("✅ Environment loaded:", envCount, "variables");
console.log(
  "✅ ULTRAVOX_API_KEY:",
  process.env.ULTRAVOX_API_KEY ? "SET" : "❌ MISSING"
);
console.log(
  "✅ ULTRAVOX_API:",
  process.env.ULTRAVOX_CALL_API ? "SET" : "❌ MISSING"
);
console.log(
  "✅ SERVER X_API_KEY:",
  process.env.SERVER_X_API_KEY ? "SET" : "❌ MISSING"
);
console.log("===============================");

// Now import other modules AFTER environment is loaded
import { Server } from "./websocket/server";

console.log("Starting Genesys Audio Connector service for voice agents...");
new Server().start();
