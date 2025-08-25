import WS, { WebSocket } from "ws";
import express, { Express, Request } from "express";
import { verifyRequestSignature } from "../auth/authenticator";
import { Session } from "./session";
import { getPort } from "../common/environment-variables";
import { SecretService } from "../services/secret-service";
import dotenv from "dotenv";
dotenv.config();
export class Server {
  private app: Express | undefined;
  private httpServer: any;
  private wsServer: any;
  private sessionMap: Map<WebSocket, Session> = new Map();
  private secretService = new SecretService();
  private readonly enableKeyVerification = true; // ENABLED for production

  start() {
    console.log(
      `${new Date().toISOString()}:[Server] Starting server on port: ${getPort()}`
    );

    this.app = express();
    this.httpServer = this.app.listen(getPort(), "0.0.0.0");
    this.wsServer = new WebSocket.Server({
      noServer: true,
    });

    // Health check endpoint (no auth required)
    this.app.get("/health", (_req, res) => {
      console.log(
        `${new Date().toISOString()}:[Server] Health check requested`
      );
      res.status(200).json({
        status: "ok",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        activeConnections: this.sessionMap.size,
        endpoint: "wss://your-domain.com/",
        authRequired: "X-API-KEY header",
        note: "This server requires X-API-KEY header for all WebSocket and API access",
      });
    });

    // Test endpoint with API key validation
    this.app.post("/test", (req, res) => {
      const apiKey = req.headers["x-api-key"] as string;

      if (!this.validateApiKey(apiKey)) {
        console.log(
          `${new Date().toISOString()}:[Server] Invalid API key in test endpoint`
        );
        return res.status(401).json({
          error: "Unauthorized",
          message: "Invalid or missing X-API-KEY header",
        });
      }

      console.log(
        `${new Date().toISOString()}:[Server] Test endpoint called with valid API key`
      );

      res.status(200).json({
        message: "Authentication successful",
        timestamp: new Date().toISOString(),
        apiKeyValid: true,
      });
    });

    // Handle WebSocket upgrade requests
    this.httpServer.on(
      "upgrade",
      (request: Request, socket: any, head: any) => {
        console.log(
          `${new Date().toISOString()}:[Server] WebSocket upgrade request from ${
            request.url
          }`
        );

        // Check X-API-KEY header for WebSocket connections
        const apiKey = request.headers["x-api-key"] as string;

        if (this.enableKeyVerification && !this.validateApiKey(apiKey)) {
          console.log(
            `${new Date().toISOString()}:[Server] WebSocket authentication failed - invalid API key`
          );
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }

        // Also verify Genesys signature if available
        verifyRequestSignature(request, this.secretService).then(
          (verifyResult) => {
            if (
              verifyResult.code !== "VERIFIED" &&
              this.enableKeyVerification
            ) {
              console.log(
                `${new Date().toISOString()}:[Server] Genesys signature verification failed`
              );
              socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
              socket.destroy();
              return;
            }

            this.wsServer.handleUpgrade(
              request,
              socket,
              head,
              (ws: WebSocket) => {
                console.log(
                  `${new Date().toISOString()}:[Server] Authentication successful - WebSocket connected`
                );
                this.wsServer.emit("connection", ws, request);
              }
            );
          }
        );
      }
    );

    // Handle new WebSocket connections
    this.wsServer.on("connection", (ws: WebSocket, request: Request) => {
      console.log(
        `${new Date().toISOString()}:[Server] New WebSocket connection established`
      );

      ws.on("close", () => {
        const session = this.sessionMap.get(ws);
        console.log(`${new Date().toISOString()}:[Server] WebSocket closed`);
        this.deleteConnection(ws);
      });

      ws.on("error", (error: Error) => {
        const session = this.sessionMap.get(ws);
        console.log(
          `${new Date().toISOString()}:[Server] WebSocket error: ${
            error.message
          }`
        );
        ws.close();
      });

      ws.on("message", (data: WS.RawData, isBinary: boolean) => {
        if (ws.readyState !== WebSocket.OPEN) {
          console.log(
            `${new Date().toISOString()}:[Server] Message received on closed socket`
          );
          return;
        }

        const session = this.sessionMap.get(ws);
        if (!session) {
          console.log(
            `${new Date().toISOString()}:[Server] No session for message`
          );
          const dummySession: Session = new Session(
            ws,
            request.headers["audiohook-session-id"] as string,
            request.url
          );
          dummySession.sendDisconnect("error", "Session does not exist.", {});
          return;
        }

        if (isBinary) {
          session.processBinaryMessage(data as Uint8Array);
        } else {
          session.processTextMessage(data.toString());
        }
      });

      this.createConnection(ws, request);
    });

    console.log(
      `${new Date().toISOString()}:[Server] Server started successfully`
    );
    console.log(
      `${new Date().toISOString()}:[Server] Genesys WebSocket endpoint: wss://your-domain.com/`
    );
    console.log(
      `${new Date().toISOString()}:[Server] Required header: X-API-KEY`
    );
  }

  private validateApiKey(apiKey: string): boolean {
    if (!apiKey) {
      console.log(
        `${new Date().toISOString()}:[Server] Missing X-API-KEY header`
      );
      return false;
    }

    // Get valid API keys from environment or secret service
    const validApiKeys = this.getValidApiKeys();

    if (!validApiKeys.includes(apiKey)) {
      console.log(
        `${new Date().toISOString()}:[Server] Invalid API key: ${apiKey.substring(
          0,
          8
        )}...`
      );
      return false;
    }

    console.log(
      `${new Date().toISOString()}:[Server] Valid API key: ${apiKey.substring(
        0,
        8
      )}...`
    );
    return true;
  }

  private getValidApiKeys(): string[] {
    // Get API keys from environment variables only (no hardcoding)
    const validKeys: string[] = [];

    // Primary API key for this server
    const primaryApiKey = process.env.SERVER_X_API_KEY;
    if (primaryApiKey) {
      validKeys.push(primaryApiKey);
    }

    // Support for multiple API keys (comma-separated)
    const additionalKeys = process.env.ADDITIONAL_API_KEYS;
    if (additionalKeys) {
      const keys = additionalKeys.split(",").map((key) => key.trim());
      validKeys.push(...keys);
    }

    // Log how many keys are loaded (without exposing them)
    console.log(
      `${new Date().toISOString()}:[Server] Loaded ${
        validKeys.length
      } valid API key(s) from environment`
    );

    if (validKeys.length === 0) {
      console.warn(
        `${new Date().toISOString()}:[Server] WARNING: No API keys configured! Set SERVER_X_API_KEY environment variable.`
      );
    }

    return validKeys.filter((key) => key && key.length > 10);
  }

  private createConnection(ws: WebSocket, request: Request) {
    let session: Session | undefined = this.sessionMap.get(ws);
    if (session) {
      return;
    }

    session = new Session(
      ws,
      request.headers["audiohook-session-id"] as string,
      request.url
    );
    console.log(
      `${new Date().toISOString()}:[Server] Created session: ${session.getClientSessionId()}`
    );
    this.sessionMap.set(ws, session);
  }

  private deleteConnection(ws: WebSocket) {
    const session: Session | undefined = this.sessionMap.get(ws);
    if (!session) {
      return;
    }

    try {
      console.log(
        `${new Date().toISOString()}:[Server] Closing session: ${session.getClientSessionId()}`
      );
      session.close();
    } catch (error) {
      console.error(
        `${new Date().toISOString()}:[Server] Error closing session:`,
        error
      );
    }

    console.log(
      `${new Date().toISOString()}:[Server] Deleted session: ${session.getClientSessionId()}`
    );
    this.sessionMap.delete(ws);
  }
}
