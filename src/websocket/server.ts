import WS, { WebSocket } from "ws";
import express, { Express, Request } from "express";
import { verifyRequestSignature } from "../auth/authenticator";
import { Session } from "./session";
import { getPort } from "../common/environment-variables";
import { SecretService } from "../services/secret-service";

export class Server {
  private app: Express | undefined;
  private httpServer: any;
  private wsServer: any;
  private sessionMap: Map<WebSocket, Session> = new Map();
  private secretService = new SecretService();
  private readonly enableKeyVerification = false; // Set to true for production

  start() {
    console.log(
      `${new Date().toISOString()}:[Server] Starting server on port: ${getPort()}`
    );

    this.app = express();
    this.httpServer = this.app.listen(getPort(), "0.0.0.0");
    this.wsServer = new WebSocket.Server({
      noServer: true,
    });

    // Health check endpoint
    this.app.get("/health", (_req, res) => {
      console.log(
        `${new Date().toISOString()}:[Server] Health check requested`
      );
      res.status(200).json({
        status: "ok",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        activeConnections: this.sessionMap.size,
      });
    });

    // Handle WebSocket upgrade requests
    this.httpServer.on(
      "upgrade",
      (request: Request, socket: any, head: any) => {
        console.log(
          `${new Date().toISOString()}:[Server] Connection request from ${
            request.url
          }`
        );

        verifyRequestSignature(request, this.secretService).then(
          (verifyResult) => {
            if (
              verifyResult.code !== "VERIFIED" &&
              this.enableKeyVerification
            ) {
              console.log(
                `${new Date().toISOString()}:[Server] Authentication failed`
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
                  `${new Date().toISOString()}:[Server] Authentication successful`
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
        `${new Date().toISOString()}:[Server] New WebSocket connection`
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
