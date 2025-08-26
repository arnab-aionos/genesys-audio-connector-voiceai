import WS, { WebSocket } from "ws";
import express, { Express, Request } from "express";
import { verifyRequestSignature } from "../auth/authenticator";
import { Session } from "./session";
import { getPort } from "../common/environment-variables";
import { SecretService } from "../services/secret-service";

console.log("=== SERVER STARTUP ===");
console.log("Time:", new Date().toISOString());
console.log("Process PID:", process.pid);
console.log("=====================");

export class Server {
  private app: Express | undefined;
  private httpServer: any;
  private wsServer: any;
  private sessionMap: Map<WebSocket, Session> = new Map();
  private secretService = new SecretService();
  private readonly enableKeyVerification =
    process.env.ENABLE_KEY_VERIFICATION !== "false";
  private readonly enableSignatureVerification =
    process.env.ENABLE_SIGNATURE_VERIFICATION !== "false";

  start() {
    console.log(`${new Date().toISOString()}:[Server] CREATING EXPRESS APP`);
    this.app = express();

    console.log(`${new Date().toISOString()}:[Server] CREATING HTTP SERVER`);
    this.httpServer = this.app.listen(getPort(), "0.0.0.0", () => {
      console.log(
        `${new Date().toISOString()}:[Server] HTTP SERVER LISTENING ON PORT ${getPort()}`
      );
    });

    console.log(
      `${new Date().toISOString()}:[Server] CREATING WEBSOCKET SERVER`
    );

    this.app = express();
    this.httpServer = this.app.listen(getPort(), "0.0.0.0");
    this.wsServer = new WebSocket.Server({
      noServer: true,
    });

    this.app.use((req, res, next) => {
      console.log("=== HTTP REQUEST ===");
      console.log("Time:", new Date().toISOString());
      console.log("Method:", req.method);
      console.log("URL:", req.url);
      console.log("Headers:", JSON.stringify(req.headers, null, 2));
      console.log("IP:", req.ip);
      console.log("==================");
      next();
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
        endpoint: "ws://localhost:3000/",
        authRequired: "X-API-KEY header or apikey query parameter",
        signatureVerification: this.enableSignatureVerification,
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
        console.log("=== WEBSOCKET UPGRADE REQUEST ===");
        console.log("Time:", new Date().toISOString());
        console.log("URL:", request.url);
        console.log("Method:", request.method);
        console.log("HTTP Version:", request.httpVersion);
        console.log("Remote Address:", socket.remoteAddress);
        console.log("Remote Port:", socket.remotePort);
        console.log("Local Address:", socket.localAddress);
        console.log("Local Port:", socket.localPort);
        console.log("All Headers:", JSON.stringify(request.headers, null, 2));

        // Check X-API-KEY header OR query parameter (for browser testing)
        let apiKey = request.headers["x-api-key"] as string;

        // If no header, check query parameter for browser testing
        if (!apiKey && request.url) {
          const url = new URL(request.url, `http://${request.headers.host}`);
          apiKey = url.searchParams.get("apikey") || "";
        }

        if (this.enableKeyVerification && !this.validateApiKey(apiKey)) {
          console.log(
            `${new Date().toISOString()}:[Server] WebSocket authentication failed - invalid API key`
          );
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }

        // Check if this is a Genesys request (has required audiohook headers)
        const hasGenesysHeaders =
          request.headers["audiohook-session-id"] ||
          request.headers["audiohook-organization-id"] ||
          request.headers["audiohook-correlation-id"];

        if (hasGenesysHeaders && this.enableSignatureVerification) {
          // This is a Genesys connection - verify signature
          console.log(
            `${new Date().toISOString()}:[Server] Genesys headers detected - verifying signature`
          );
          verifyRequestSignature(request, this.secretService).then(
            (verifyResult) => {
              if (verifyResult.code !== "VERIFIED") {
                console.log(
                  `${new Date().toISOString()}:[Server] Genesys signature verification failed: ${
                    verifyResult.code
                  }`
                );
                socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
                socket.destroy();
                return;
              }
              console.log(
                `${new Date().toISOString()}:[Server] Genesys signature verified successfully`
              );
              this.handleWebSocketUpgrade(request, socket, head);
            }
          );
        } else {
          // This is a test/browser connection or signature verification is disabled
          if (!hasGenesysHeaders) {
            console.log(
              `${new Date().toISOString()}:[Server] Test connection detected - no Genesys headers found`
            );
          } else {
            console.log(
              `${new Date().toISOString()}:[Server] Signature verification disabled via environment`
            );
          }
          this.handleWebSocketUpgrade(request, socket, head);
        }

        console.log(
          "Genesys Headers:",
          JSON.stringify(request.headers, null, 2)
        );

        console.log("Socket Ready State:", socket.readyState);
        console.log("Socket Destroyed:", socket.destroyed);
        console.log("================================");
      }
    );

    // Handle new WebSocket connections
    this.wsServer.on("connection", (ws: WebSocket, request: Request) => {
      console.log(
        `${new Date().toISOString()}:[Server] New WebSocket connection established`
      );

      ws.on("close", () => {
        console.log(`${new Date().toISOString()}:[Server] WebSocket closed`);
        this.deleteConnection(ws);
      });

      ws.on("error", (error: Error) => {
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
      `${new Date().toISOString()}:[Server] WebSocket endpoint: ws://localhost:${getPort()}/`
    );
    console.log(
      `${new Date().toISOString()}:[Server] API Key verification: ${
        this.enableKeyVerification
      }`
    );
    console.log(
      `${new Date().toISOString()}:[Server] Signature verification: ${
        this.enableSignatureVerification
      }`
    );
  }

  private handleWebSocketUpgrade(request: Request, socket: any, head: any) {
    this.wsServer.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      console.log(
        `${new Date().toISOString()}:[Server] Authentication successful - WebSocket connected`
      );
      this.wsServer.emit("connection", ws, request);
    });
  }

  private validateApiKey(apiKey: string): boolean {
    if (!apiKey) {
      console.log(`${new Date().toISOString()}:[Server] Missing API key`);
      return false;
    }

    const validApiKey = process.env.SERVER_X_API_KEY;

    if (!validApiKey) {
      console.warn(
        `${new Date().toISOString()}:[Server] WARNING: SERVER_X_API_KEY not configured!`
      );
      return false;
    }

    if (apiKey !== validApiKey) {
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
