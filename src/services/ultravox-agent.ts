import WebSocket from "ws";
import fetch from "node-fetch";
import { Session } from "../websocket/session";
import { VoiceAIAgentBaseClass } from "./voice-aiagent-base";
import { getNoInputTimeout } from "../common/environment-variables";

const ULTRAVOX_API_KEY = process.env.ULTRAVOX_API_KEY || "";
const ULTRAVOX_CALL_API =
  process.env.ULTRAVOX_CALL_API || "https://api.ultravox.ai/v1/calls";

// CRITICAL: Audio format configuration based on official docs
const GENESYS_SAMPLE_RATE = 8000; // Genesys PCMU
const ULTRAVOX_SAMPLE_RATE = 48000; // UltraVox requirement from docs
const AUDIO_FRAME_SIZE_MS = 20; // 20ms frames as required
const BYTES_PER_SAMPLE = 2; // 16-bit = 2 bytes
const CHANNELS = 1; // Mono

export class UltraVoxAgent extends VoiceAIAgentBaseClass {
  private ultraVoxWs: WebSocket | null = null;
  private callId: string = "";
  private joinUrl: string = "";
  private isInitializing: boolean = false;
  private audioStreamingTask: NodeJS.Timeout | null = null;
  private audioBuffer: Int16Array = new Int16Array(0);
  private lastAudioSentTime = 0;

  constructor(session: Session) {
    super(
      session,
      () => {
        console.log(`${new Date().toISOString()}:[UltraVox] No input timeout`);
        this.handleNoInput();
      },
      getNoInputTimeout()
    );

    this.initializeUltraVoxCall();
  }

  private async createCall(): Promise<{ callId: string; joinUrl: string }> {
    const todayDate = new Date().toLocaleString();
    const systemPrompt = this.getSystemPrompt().replace(
      /{{TODAY_DATE}}/g,
      todayDate
    );

    // FIXED: Correct configuration based on official docs
    const callConfig = {
      systemPrompt: systemPrompt,
      model: process.env.ULTRAVOX_MODEL || "fixie-ai/ultravox",
      voice: process.env.ULTRAVOX_VOICE || "terrance",
      temperature: 0.3,
      firstSpeaker: "FIRST_SPEAKER_AGENT",
      medium: {
        serverWebSocket: {
          inputSampleRate: ULTRAVOX_SAMPLE_RATE, // MUST be 48kHz per docs
          outputSampleRate: ULTRAVOX_SAMPLE_RATE, // MUST match input
          clientBufferSizeMs: 60, // Keep at 60ms as recommended
        },
      },
      selectedTools: [],
    };

    console.log(
      `${new Date().toISOString()}:[UltraVox] Creating call with correct config`
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

    const data = (await response.json()) as {
      callId: string;
      joinUrl: string;
      [key: string]: any;
    };
    return { callId: data.callId, joinUrl: data.joinUrl };
  }

  private async connectWebSocket(joinUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log(
        `${new Date().toISOString()}:[UltraVox] Connecting to: ${joinUrl}`
      );

      this.ultraVoxWs = new WebSocket(joinUrl);

      // CRITICAL: Set binary type for audio data
      this.ultraVoxWs.binaryType = "arraybuffer";

      const timeout = setTimeout(() => {
        reject(new Error("WebSocket connection timeout"));
      }, 10000);

      this.ultraVoxWs.on("open", () => {
        clearTimeout(timeout);
        console.log(
          `${new Date().toISOString()}:[UltraVox] WebSocket connected - starting audio streaming`
        );
        this.startContinuousAudioStreaming();
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

      this.ultraVoxWs.on("close", () => {
        console.log(`${new Date().toISOString()}:[UltraVox] WebSocket closed`);
        this.stopContinuousAudioStreaming();
        this.ultraVoxWs = null;
      });
    });
  }

  // CRITICAL: Implement continuous audio streaming as required by UltraVox
  private startContinuousAudioStreaming(): void {
    if (this.audioStreamingTask) {
      clearInterval(this.audioStreamingTask);
    }

    const frameSize =
      Math.floor((ULTRAVOX_SAMPLE_RATE * AUDIO_FRAME_SIZE_MS) / 1000) *
      CHANNELS;
    console.log(
      `${new Date().toISOString()}:[UltraVox] Starting continuous streaming: ${frameSize} samples every ${AUDIO_FRAME_SIZE_MS}ms`
    );

    this.audioStreamingTask = setInterval(() => {
      this.sendAudioFrame(frameSize);
    }, AUDIO_FRAME_SIZE_MS);
  }

  private stopContinuousAudioStreaming(): void {
    if (this.audioStreamingTask) {
      clearInterval(this.audioStreamingTask);
      this.audioStreamingTask = null;
      console.log(
        `${new Date().toISOString()}:[UltraVox] Stopped continuous audio streaming`
      );
    }
  }

  private sendAudioFrame(frameSize: number): void {
    if (!this.isAgentConnected()) return;

    // Extract frame from buffer or send silence
    let frame: Int16Array;

    if (this.audioBuffer.length >= frameSize) {
      frame = this.audioBuffer.slice(0, frameSize);
      this.audioBuffer = this.audioBuffer.slice(frameSize);
    } else {
      // Send silence when no audio available (critical for UltraVox timing)
      frame = new Int16Array(frameSize).fill(0);
    }

    // Convert Int16Array to ArrayBuffer for WebSocket
    const audioData = new ArrayBuffer(frame.length * 2);
    const view = new Int16Array(audioData);
    view.set(frame);

    this.ultraVoxWs?.send(audioData);
  }

  // FIXED: Process incoming customer audio correctly
  async processAudio(audioPayload: Uint8Array): Promise<void> {
    if (!this.isAgentConnected()) return;

    console.log(
      `${new Date().toISOString()}:[UltraVox] Processing customer audio: ${
        audioPayload.length
      } bytes`
    );

    // STEP 1: Convert PCMU (μ-law) to linear PCM
    const pcmSamples = this.convertPCMUToPCMSamples(audioPayload);

    // STEP 2: Resample from 8kHz to 48kHz (critical!)
    const resampledSamples = this.resampleAudio(
      pcmSamples,
      GENESYS_SAMPLE_RATE,
      ULTRAVOX_SAMPLE_RATE
    );

    // STEP 3: Add to buffer for continuous streaming
    const newBuffer = new Int16Array(
      this.audioBuffer.length + resampledSamples.length
    );
    newBuffer.set(this.audioBuffer);
    newBuffer.set(resampledSamples, this.audioBuffer.length);
    this.audioBuffer = newBuffer;

    console.log(
      `${new Date().toISOString()}:[UltraVox] Added ${
        resampledSamples.length
      } samples to buffer (total: ${this.audioBuffer.length})`
    );
  }

  private handleUltraVoxMessage(data: any): void {
    try {
      if (data instanceof ArrayBuffer) {
        // FIXED: Handle binary audio data from UltraVox
        const audioData = new Int16Array(data);
        console.log(
          `${new Date().toISOString()}:[UltraVox] Received agent audio: ${
            audioData.length
          } samples`
        );

        // Convert 48kHz back to 8kHz for Genesys
        const downsampledAudio = this.resampleAudio(
          audioData,
          ULTRAVOX_SAMPLE_RATE,
          GENESYS_SAMPLE_RATE
        );

        // Convert to PCMU for Genesys
        const pcmuData = this.convertPCMSamplesToPCMU(downsampledAudio);

        // Send to Genesys customer
        this.session.sendAudioFromAgent(pcmuData);
        return;
      }

      // Handle JSON messages
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

        default:
          console.log(
            `${new Date().toISOString()}:[UltraVox] Unhandled message: ${
              message.type
            }`
          );
      }
    } catch (error) {
      console.error(
        `${new Date().toISOString()}:[UltraVox] Message processing error:`,
        error
      );
    }
  }

  // CRITICAL: Proper sample rate conversion
  private resampleAudio(
    input: Int16Array,
    inputSampleRate: number,
    outputSampleRate: number
  ): Int16Array {
    if (inputSampleRate === outputSampleRate) {
      return input;
    }

    const ratio = outputSampleRate / inputSampleRate;
    const outputLength = Math.floor(input.length * ratio);
    const output = new Int16Array(outputLength);

    for (let i = 0; i < outputLength; i++) {
      const srcIndex = i / ratio;
      const srcIndexFloor = Math.floor(srcIndex);
      const srcIndexCeil = Math.min(srcIndexFloor + 1, input.length - 1);

      // Linear interpolation
      const fraction = srcIndex - srcIndexFloor;
      const sample1 = input[srcIndexFloor] || 0;
      const sample2 = input[srcIndexCeil] || 0;

      output[i] = Math.round(sample1 + (sample2 - sample1) * fraction);
    }

    return output;
  }

  private convertPCMUToPCMSamples(pcmuData: Uint8Array): Int16Array {
    const pcmSamples = new Int16Array(pcmuData.length);
    for (let i = 0; i < pcmuData.length; i++) {
      pcmSamples[i] = this.ulawToPcm(pcmuData[i]);
    }
    return pcmSamples;
  }

  private convertPCMSamplesToPCMU(pcmSamples: Int16Array): Uint8Array {
    const pcmuData = new Uint8Array(pcmSamples.length);
    for (let i = 0; i < pcmSamples.length; i++) {
      pcmuData[i] = this.pcmToUlaw(pcmSamples[i]);
    }
    return pcmuData;
  }

  // Keep existing μ-law conversion methods...
  private ulawToPcm(ulaw: number): number {
    const BIAS = 0x84;
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
      // Send silence or prompt message to UltraVox
      const message = {
        type: "user_message",
        text:
          process.env.NO_INPUT_MESSAGE ||
          "User has been silent. Please ask if they need help.",
      };
      this.ultraVoxWs?.send(JSON.stringify(message));
    }
  }

  async processPlaybackCompleted(): Promise<void> {
    console.log(`${new Date().toISOString()}:[UltraVox] Playback completed`);
    this.noInputTimer.startTimer();
  }

  async sendKeepAlive(): Promise<void> {
    if (this.isAgentConnected()) {
      const keepAlive = { type: "ping", timestamp: Date.now() };
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

    this.stopContinuousAudioStreaming();

    if (this.ultraVoxWs) {
      this.ultraVoxWs.close(1000, "Session ended");
      this.ultraVoxWs = null;
    }

    this.callId = "";
    this.joinUrl = "";
  }

  private async initializeUltraVoxCall(): Promise<void> {
    if (this.isInitializing) return;
    this.isInitializing = true;

    try {
      console.log(
        `${new Date().toISOString()}:[UltraVox] Creating UltraVox call...`
      );
      const callResponse = await this.createCall();
      this.callId = callResponse.callId;
      this.joinUrl = callResponse.joinUrl;

      console.log(
        `${new Date().toISOString()}:[UltraVox] Call created - ID: ${
          this.callId
        }`
      );
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
}
