import WebSocket from "ws";
import fetch from "node-fetch";
import { Session } from "../websocket/session";
import { VoiceAIAgentBaseClass } from "./voice-aiagent-base";
import { getNoInputTimeout } from "../common/environment-variables";

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

    // FIXED: Use serverWebSocket instead of webRtc
    const callConfig = {
      systemPrompt: systemPrompt,
      model: ULTRAVOX_MODEL,
      voice: ULTRAVOX_VOICE,
      temperature: 0.3,
      firstSpeaker: "FIRST_SPEAKER_AGENT",
      medium: {
        serverWebSocket: {
          inputSampleRate: 8000, // Match Genesys PCMU rate
          outputSampleRate: 8000, // Keep consistent
          clientBufferSizeMs: 60, // Balance latency vs stability
        },
      },
      selectedTools: [],
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
      console.log(
        `${new Date().toISOString()}:[UltraVox] Connecting to: ${joinUrl}`
      );

      // FIXED: Use joinUrl directly for serverWebSocket (no protocol conversion needed)
      this.ultraVoxWs = new WebSocket(joinUrl);

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
        // Audio data from UltraVox (PCM format)
        console.log(
          `${new Date().toISOString()}:[UltraVox] Audio received: ${
            data.length
          } bytes`
        );

        // FIXED: Convert PCM back to PCMU for Genesys
        const pcmuAudio = this.convertPCMToPCMU(new Uint8Array(data));
        this.session.sendAudio(pcmuAudio);
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

  // FIXED: Add audio format conversion methods
  private convertPCMUToPCM(pcmuData: Uint8Array): Uint8Array {
    // Convert μ-law (PCMU) to linear PCM (s16le)
    const pcmData = new Int16Array(pcmuData.length);

    for (let i = 0; i < pcmuData.length; i++) {
      pcmData[i] = this.ulawToPcm(pcmuData[i]);
    }

    return new Uint8Array(pcmData.buffer);
  }

  private convertPCMToPCMU(pcmData: Uint8Array): Uint8Array {
    // Convert linear PCM (s16le) back to μ-law (PCMU)
    const int16Array = new Int16Array(pcmData.buffer);
    const pcmuData = new Uint8Array(int16Array.length);

    for (let i = 0; i < int16Array.length; i++) {
      pcmuData[i] = this.pcmToUlaw(int16Array[i]);
    }

    return pcmuData;
  }

  // μ-law to linear PCM conversion
  private ulawToPcm(ulaw: number): number {
    const BIAS = 0x84;
    const CLIP = 8159;

    ulaw = ~ulaw;
    const sign = ulaw & 0x80;
    const exponent = (ulaw >> 4) & 0x07;
    const mantissa = ulaw & 0x0f;

    let sample = mantissa << (exponent + 3);
    sample += BIAS;
    if (exponent !== 0) {
      sample += 1 << (exponent + 2);
    }

    return sign !== 0 ? -sample : sample;
  }

  // Linear PCM to μ-law conversion
  private pcmToUlaw(pcm: number): number {
    const BIAS = 0x84;
    const CLIP = 8159;

    if (pcm < 0) {
      pcm = BIAS - pcm;
    } else {
      pcm = BIAS + pcm;
    }

    if (pcm > CLIP) pcm = CLIP;

    let exponent = 7;
    let expMask = 0x4000;
    while ((pcm & expMask) === 0 && exponent > 0) {
      exponent--;
      expMask >>= 1;
    }

    const mantissa = (pcm >> (exponent + 3)) & 0x0f;
    const ulaw = ~((exponent << 4) | mantissa);

    return ulaw & 0xff;
  }

  // FIXED: Convert incoming PCMU to PCM before sending to UltraVox
  async processAudio(audioPayload: Uint8Array): Promise<void> {
    if (this.isAgentConnected()) {
      // Convert PCMU to PCM before sending to UltraVox
      const pcmAudio = this.convertPCMUToPCM(audioPayload);
      this.ultraVoxWs?.send(pcmAudio);
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
