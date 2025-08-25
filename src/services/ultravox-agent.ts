import WebSocket from "ws";
import fetch from "node-fetch";
import { Session } from "../websocket/session";
import { VoiceAIAgentBaseClass } from "./voice-aiagent-base";
import { getNoInputTimeout } from "../common/environment-variables";

import dotenv from "dotenv";
dotenv.config();

// UltraVox Configuration
const ULTRAVOX_API_KEY = process.env.ULTRAVOX_API_KEY || "";
const ULTRAVOX_CALL_API =
  process.env.ULTRAVOX_CALL_API || "https://api.ultravox.ai/v1/calls";
const ULTRAVOX_MODEL = process.env.ULTRAVOX_MODEL || "fixie-ai/ultravox";
const ULTRAVOX_VOICE = process.env.ULTRAVOX_VOICE || "terrance";

if (!ULTRAVOX_API_KEY) {
  console.error("[UltraVox] Missing ULTRAVOX_API_KEY environment variable");
  process.exit(1);
}

if (!ULTRAVOX_CALL_API) {
  console.error("[UltraVox] Missing ULTRAVOX_CALL_API environment variable");
  process.exit(1);
}

interface UltraVoxCallResponse {
  callId: string;
  joinUrl: string;
}

export class UltraVoxAgent extends VoiceAIAgentBaseClass {
  private ultraVoxWs: WebSocket | null = null;
  private callId: string = "";
  private joinUrl: string = "";
  private isInitializing: boolean = false;

  constructor(session: Session) {
    super(
      session,
      () => {
        console.log(
          `${new Date().toISOString()}:[UltraVox] No input timeout - prompting user`
        );
        this.handleNoInput();
      },
      getNoInputTimeout()
    );

    this.initializeUltraVoxCall();
  }

  private async initializeUltraVoxCall(): Promise<void> {
    if (this.isInitializing) return;

    this.isInitializing = true;
    console.log(
      `${new Date().toISOString()}:[UltraVox] Creating UltraVox call...`
    );

    try {
      const callResponse = await this.createCall();
      this.callId = callResponse.callId;
      this.joinUrl = callResponse.joinUrl;

      console.log(
        `${new Date().toISOString()}:[UltraVox] Call created - ID: ${
          this.callId
        }`
      );

      // Connect to WebSocket using joinUrl
      await this.connectWebSocket(this.joinUrl);
    } catch (error) {
      console.error(
        `${new Date().toISOString()}:[UltraVox] Initialization failed:`,
        error
      );
      this.session.sendDisconnect(
        "error",
        "Failed to initialize AI service",
        {}
      );
    } finally {
      this.isInitializing = false;
    }
  }

  private async createCall(): Promise<UltraVoxCallResponse> {
    const todayDate = new Date().toLocaleString();
    const systemPrompt = this.getSystemPrompt().replace(
      /{{TODAY_DATE}}/g,
      todayDate
    );

    // Use your exact working configuration
    const callConfig = {
      systemPrompt: systemPrompt,
      model: ULTRAVOX_MODEL,
      voice: ULTRAVOX_VOICE,
      temperature: 0.3,
      firstSpeaker: "FIRST_SPEAKER_AGENT",
      medium: { webRtc: {} },
      selectedTools: [], // No tools for simplicity
    };

    console.log(
      `${new Date().toISOString()}:[UltraVox] Call config:`,
      JSON.stringify(callConfig, null, 2)
    );

    const response = await fetch(ULTRAVOX_CALL_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": ULTRAVOX_API_KEY,
      },
      body: JSON.stringify(callConfig),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`UltraVox API error: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as UltraVoxCallResponse;
    console.log(`${new Date().toISOString()}:[UltraVox] Call response:`, data);

    return data;
  }

  private async connectWebSocket(joinUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Convert joinUrl to WebSocket URL if needed
      let webSocketUrl = joinUrl;
      if (webSocketUrl.startsWith("https://")) {
        webSocketUrl = webSocketUrl.replace("https://", "wss://");
      } else if (webSocketUrl.startsWith("http://")) {
        webSocketUrl = webSocketUrl.replace("http://", "ws://");
      }

      console.log(
        `${new Date().toISOString()}:[UltraVox] Connecting to: ${webSocketUrl}`
      );

      this.ultraVoxWs = new WebSocket(webSocketUrl);

      const timeout = setTimeout(() => {
        reject(new Error("WebSocket connection timeout"));
      }, 10000);

      this.ultraVoxWs.on("open", () => {
        clearTimeout(timeout);
        console.log(
          `${new Date().toISOString()}:[UltraVox] WebSocket connected`
        );
        resolve();
      });

      this.ultraVoxWs.on("message", (data: any) => {
        this.handleUltraVoxMessage(data);
      });

      this.ultraVoxWs.on("error", (error: Error) => {
        clearTimeout(timeout);
        console.error(
          `${new Date().toISOString()}:[UltraVox] WebSocket error:`,
          error
        );
        reject(error);
      });

      this.ultraVoxWs.on("close", (code: number, reason: Buffer) => {
        console.log(
          `${new Date().toISOString()}:[UltraVox] WebSocket closed: ${code} ${reason.toString()}`
        );
        this.ultraVoxWs = null;
      });
    });
  }

  private handleUltraVoxMessage(data: any): void {
    try {
      if (Buffer.isBuffer(data)) {
        // Audio data from UltraVox
        console.log(
          `${new Date().toISOString()}:[UltraVox] Audio received: ${
            data.length
          } bytes`
        );
        this.session.sendAudio(new Uint8Array(data));
        return;
      }

      const message = JSON.parse(data.toString());
      console.log(
        `${new Date().toISOString()}:[UltraVox] Message: ${message.type}`
      );

      switch (message.type) {
        case "transcript":
          if (message.text) {
            this.session.sendTranscript(
              message.text,
              message.confidence || 0.9,
              message.isFinal || false
            );
          }
          break;

        case "user_started_speaking":
          if (this.session.getIsAudioPlaying()) {
            this.session.sendBargeIn();
          }
          this.session.setIsAudioPlaying(false);
          this.noInputTimer.haltTimer();
          break;

        case "user_stopped_speaking":
          this.noInputTimer.resumeTimer();
          break;

        case "agent_started_speaking":
          this.session.setIsAudioPlaying(true);
          break;

        case "agent_stopped_speaking":
          this.session.flushBuffer();
          this.session.setIsAudioPlaying(false);
          break;

        case "call_ended":
          console.log(`${new Date().toISOString()}:[UltraVox] Call ended`);
          this.session.sendDisconnect("completed", "Call completed", {});
          break;

        case "error":
          console.error(
            `${new Date().toISOString()}:[UltraVox] Error:`,
            message
          );
          this.session.sendDisconnect(
            "error",
            message.message || "UltraVox error",
            {}
          );
          break;
      }
    } catch (error) {
      console.error(
        `${new Date().toISOString()}:[UltraVox] Message processing error:`,
        error
      );
    }
  }

  private getSystemPrompt(): string {
    const customPrompt = this.session.getInputVariables()?.systemPrompt;
    return (
      customPrompt ||
      process.env.DEFAULT_SYSTEM_PROMPT ||
      "You are a helpful AI assistant. Respond naturally and be concise."
    );
  }

  private handleNoInput(): void {
    if (this.isAgentConnected()) {
      const message = {
        type: "user_message",
        text:
          process.env.NO_INPUT_MESSAGE ||
          "User has been silent. Please ask if they need help.",
      };
      this.ultraVoxWs?.send(JSON.stringify(message));
    }
  }

  // Abstract method implementations
  async processAudio(audioPayload: Uint8Array): Promise<void> {
    if (this.isAgentConnected()) {
      // Send raw audio to UltraVox
      this.ultraVoxWs?.send(audioPayload);
    }
  }

  async processPlaybackCompleted(): Promise<void> {
    console.log(`${new Date().toISOString()}:[UltraVox] Playback completed`);
    this.noInputTimer.startTimer();
  }

  async sendKeepAlive(): Promise<void> {
    if (this.isAgentConnected()) {
      const keepAlive = {
        type: "ping",
        timestamp: Date.now(),
      };
      this.ultraVoxWs?.send(JSON.stringify(keepAlive));
    }
  }

  protected isAgentConnected(): boolean {
    return (
      this.ultraVoxWs !== null && this.ultraVoxWs.readyState === WebSocket.OPEN
    );
  }

  async close(): Promise<void> {
    console.log(`${new Date().toISOString()}:[UltraVox] Closing connection`);

    if (this.ultraVoxWs) {
      this.ultraVoxWs.close(1000, "Session ended");
      this.ultraVoxWs = null;
    }

    this.callId = "";
    this.joinUrl = "";
  }
}
