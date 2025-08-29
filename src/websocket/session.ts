import { v4 as uuid } from "uuid";
import { WebSocket } from "ws";
import { JsonStringMap, MediaParameter } from "../protocol/core";
import {
  ClientMessage,
  DisconnectParameters,
  DisconnectReason,
  EventParameters,
  SelectParametersForType,
  ServerMessage,
  ServerMessageBase,
  ServerMessageType,
} from "../protocol/message";
import {
  BotTurnDisposition,
  EventEntityBargeIn,
  EventEntityBotTurnResponse,
} from "../protocol/voice-bots";
import {
  EventEntityDataTranscript,
  EventEntityTranscript,
} from "../protocol/entities-transcript";
import { MessageHandlerRegistry } from "./message-handlers/message-handler-registry";
import { DTMFService } from "../services/dtmf-service";
import { VoiceAIAgentBaseClass } from "../services/voice-aiagent-base";
import { VoiceAIAgentFactory } from "../services/voice-aiagent-factory";
import {
  getMAXBinaryMessageSize,
  getMinBinaryMessageSize,
  getISTTime,
} from "../common/environment-variables";

const BOT_PROVIDER = process.env.BOT_PROVIDER || "UltraVox";

export class Session {
  private MAXIMUM_BINARY_MESSAGE_SIZE = getMAXBinaryMessageSize();
  private MIN_BINARY_MESSAGE_SIZE = getMinBinaryMessageSize();
  private disconnecting = false;
  private closed = false;
  private ws;

  private messageHandlerRegistry = new MessageHandlerRegistry();
  private dtmfService: DTMFService | null = null;
  private voiceAIAgentClient: VoiceAIAgentBaseClass | null = null;

  private url;
  private clientSessionId;
  private conversationId: string | undefined;
  private lastServerSequenceNumber = 0;
  private lastClientSequenceNumber = 0;
  private inputVariables: JsonStringMap = {};
  private selectedMedia: MediaParameter | undefined;

  private isCapturingDTMF = false;
  private isAudioPlaying = false;
  private buffer: Array<Uint8Array> = new Array<Uint8Array>();

  private lastAudioSendTime = 0;
  private readonly MIN_SEND_INTERVAL = 50; // ms

  constructor(
    ws: WebSocket,
    sessionId: string | undefined,
    url: string | undefined
  ) {
    this.ws = ws;
    this.clientSessionId = sessionId || this.generateSessionId();
    this.url = url || "";

    if (!sessionId) {
      console.warn(
        `${getISTTime()}:[Session] No session ID provided - generated: ${
          this.clientSessionId
        }`
      );
    } else {
      console.log(
        `${getISTTime()}:[Session] Created session: ${this.clientSessionId}`
      );
    }

    // FIXED: DON'T initialize UltraVox here - wait for Genesys "open" message
    console.log(
      `${getISTTime()}:[Session] Session ready - waiting for Genesys 'open' message to initialize voice agent`
    );
  }

  // NEW METHOD: Initialize voice agent after Genesys handshake
  initializeVoiceAgent() {
    if (this.voiceAIAgentClient) {
      console.log(`${getISTTime()}:[Session] Voice agent already initialized`);
      return;
    }

    try {
      console.log(
        `${getISTTime()}:[Session] Starting UltraVox after Genesys handshake completed`
      );
      this.voiceAIAgentClient = VoiceAIAgentFactory.create(BOT_PROVIDER, this);
      console.log(
        `${getISTTime()}:[Session] Voice AI Agent initialized: ${BOT_PROVIDER}`
      );
    } catch (error) {
      console.error(
        `${getISTTime()}:[Session] Failed to initialize Voice AI Agent:`,
        error
      );
      this.sendDisconnect("error", "Failed to initialize AI service", {});
    }
  }

  private generateSessionId(): string {
    return `test-session-${Date.now()}-${Math.random()
      .toString(36)
      .substr(2, 9)}`;
  }

  // Getters for agent access
  getClientSessionId(): string {
    return this.clientSessionId;
  }
  getIsAudioPlaying(): boolean {
    return this.isAudioPlaying;
  }
  getInputVariables(): JsonStringMap {
    return this.inputVariables;
  }
  getConversationId(): string | undefined {
    return this.conversationId;
  }

  close() {
    if (this.closed) {
      console.log(`${getISTTime()}:[Session] Already closed`);
      return;
    }

    try {
      console.log(
        `${getISTTime()}:[Session] Closing session: ${this.clientSessionId}`
      );

      // Close Voice AI Agent first (if initialized)
      this.voiceAIAgentClient?.close();

      // Close WebSocket
      this.ws.close();
    } catch (error) {
      console.error(`${getISTTime()}:[Session] Error closing:`, error);
    }

    this.closed = true;
    console.log(
      `${getISTTime()}:[Session] Session closed: ${this.clientSessionId}`
    );
  }

  setConversationId(conversationId: string) {
    this.conversationId = conversationId;
    console.log(`${getISTTime()}:[Session] Conversation ID: ${conversationId}`);
  }

  setInputVariables(inputVariables: JsonStringMap) {
    this.inputVariables = inputVariables;
    console.log(
      `${getISTTime()}:[Session] Input variables:`,
      JSON.stringify(inputVariables)
    );
  }

  setSelectedMedia(selectedMedia: MediaParameter) {
    this.selectedMedia = selectedMedia;
    console.log(
      `${getISTTime()}:[Session] Media:`,
      JSON.stringify(selectedMedia)
    );
  }

  setIsAudioPlaying(isAudioPlaying: boolean) {
    this.isAudioPlaying = isAudioPlaying;
    console.log(`${getISTTime()}:[Session] Audio playing: ${isAudioPlaying}`);
  }

  playbackCompleted() {
    console.log(`${getISTTime()}:[Session] Playback completed`);
    this.setIsAudioPlaying(false);
    this.voiceAIAgentClient?.processPlaybackCompleted();
  }

  processTextMessage(data: string) {
    if (this.closed) {
      console.log(
        `${getISTTime()}:[Session] Ignoring text message - session closed`
      );
      return;
    }

    try {
      const message = JSON.parse(data);
      console.log(
        `${getISTTime()}:[Session] Processing message: ${message.type}`
      );

      // Handle test messages more gracefully
      if (this.isTestConnection(message)) {
        this.handleTestMessage(message);
        return;
      }

      // Validate sequence numbers for production Genesys messages
      if (
        message.seq !== undefined &&
        message.seq !== this.lastClientSequenceNumber + 1
      ) {
        console.warn(
          `${getISTTime()}:[Session] Invalid client sequence: expected ${
            this.lastClientSequenceNumber + 1
          }, got ${message.seq}`
        );
        // For test connections, warn but continue; for production, disconnect
        if (this.isProductionConnection()) {
          this.sendDisconnect("error", "Invalid client sequence number.", {});
          return;
        }
      }

      if (message.seq !== undefined) {
        this.lastClientSequenceNumber = message.seq;
      }

      if (
        message.serverseq !== undefined &&
        message.serverseq > this.lastServerSequenceNumber
      ) {
        console.warn(
          `${getISTTime()}:[Session] Invalid server sequence: ${
            message.serverseq
          }`
        );
        if (this.isProductionConnection()) {
          this.sendDisconnect("error", "Invalid server sequence number.", {});
          return;
        }
      }

      // More flexible ID validation
      if (message.id && message.id !== this.clientSessionId) {
        console.warn(
          `${getISTTime()}:[Session] Session ID mismatch: expected ${
            this.clientSessionId
          }, got ${message.id}`
        );
        if (this.isProductionConnection()) {
          this.sendDisconnect("error", "Invalid ID specified.", {});
          return;
        }
      }

      const handler = this.messageHandlerRegistry.getHandler(message.type);
      if (!handler) {
        console.log(
          `${getISTTime()}:[Session] No handler for: ${message.type}`
        );
        return;
      }

      handler.handleMessage(message as ClientMessage, this);
    } catch (error) {
      console.error(
        `${getISTTime()}:[Session] Error processing text message:`,
        error
      );
      if (this.isProductionConnection()) {
        this.sendDisconnect("error", "Message processing error", {});
      }
    }
  }

  private isTestConnection(message: any): boolean {
    // Test connections typically send simple messages without proper protocol structure
    return (
      (message.type === "ping" || message.type === "test") &&
      (message.seq === undefined ||
        message.id === undefined ||
        message.serverseq === undefined)
    );
  }

  private isProductionConnection(): boolean {
    // Production connections have audiohook headers or conversation ID
    return (
      this.conversationId !== undefined ||
      this.clientSessionId.includes("audiohook")
    );
  }

  private handleTestMessage(message: any) {
    console.log(
      `${getISTTime()}:[Session] Handling test message: ${message.type}`
    );

    if (message.type === "ping" || message.type === "test") {
      // Send a simple test response
      const testResponse = {
        type: "pong",
        timestamp: getISTTime(),
        status: "ok",
        message:
          "Test connection successful - waiting for Genesys 'open' message to start voice agent",
      };

      console.log(`${getISTTime()}:[Session] Sending test pong response`);

      this.ws.send(JSON.stringify(testResponse));
    }
  }

  createMessage<Type extends ServerMessageType, Message extends ServerMessage>(
    type: Type,
    parameters: SelectParametersForType<Type, Message>
  ): ServerMessage {
    const message: ServerMessageBase<Type, typeof parameters> = {
      id: this.clientSessionId as string,
      version: "2",
      seq: ++this.lastServerSequenceNumber,
      clientseq: this.lastClientSequenceNumber,
      type,
      parameters,
    };
    return message as ServerMessage;
  }

  send(message: ServerMessage) {
    if (this.closed) {
      console.log(`${getISTTime()}:[Session] Cannot send - session closed`);
      return;
    }

    if (message.type === "event") {
      console.log(
        `${getISTTime()}:[Session] Sending event: ${
          message.parameters.entities[0].type
        }`
      );
    } else {
      console.log(`${getISTTime()}:[Session] Sending: ${message.type}`);
    }

    this.ws.send(JSON.stringify(message));
  }

  flushBuffer() {
    const totalLength =
      this.buffer?.reduce((acc, curr) => acc + curr.length, 0) || 0;
    if (totalLength <= 0) {
      console.log(`${getISTTime()}:[Session] Buffer empty - nothing to flush`);
      return;
    }

    const bytes = new Uint8Array(totalLength);
    let offset = 0;
    for (const byteArray of this.buffer) {
      bytes.set(byteArray, offset);
      offset += byteArray.length;
    }
    this.buffer.length = 0;

    this.sendAudioChunks(bytes);
  }

  sendAudio(currBytes: Uint8Array) {
    if (this.closed) {
      console.log(
        `${getISTTime()}:[Session] Cannot send audio - session closed`
      );
      return;
    }

    const now = Date.now();
    if (now - this.lastAudioSendTime < this.MIN_SEND_INTERVAL) {
      return;
    }
    this.lastAudioSendTime = now;

    this.buffer.push(currBytes);
    const totalLength =
      this.buffer?.reduce((acc, curr) => acc + curr.length, 0) || 0;

    if (totalLength < this.MIN_BINARY_MESSAGE_SIZE) {
      console.log(
        `${getISTTime()}:[Session] Buffering audio (${totalLength}/${
          this.MIN_BINARY_MESSAGE_SIZE
        })`
      );
      setTimeout(this.flushBuffer.bind(this), 500);
      return;
    }

    const bytes = new Uint8Array(totalLength);
    let offset = 0;
    for (const byteArray of this.buffer) {
      bytes.set(byteArray, offset);
      offset += byteArray.length;
    }
    this.buffer.length = 0;

    this.sendAudioChunks(bytes);
  }

  private sendAudioChunks(bytes: Uint8Array) {
    if (bytes.length <= this.MAXIMUM_BINARY_MESSAGE_SIZE) {
      console.log(
        `${getISTTime()}:[Session] Sending audio: ${bytes.length} bytes`
      );
      this.ws.send(bytes, { binary: true });
    } else {
      let currentPosition = 0;
      let chunkCount = 0;

      while (currentPosition < bytes.length) {
        const sendBytes = bytes.slice(
          currentPosition,
          currentPosition + this.MAXIMUM_BINARY_MESSAGE_SIZE
        );
        console.log(
          `${getISTTime()}:[Session] Sending chunk ${++chunkCount}: ${
            sendBytes.length
          } bytes`
        );
        this.ws.send(sendBytes, { binary: true });
        currentPosition += this.MAXIMUM_BINARY_MESSAGE_SIZE;
      }
    }
  }

  sendBargeIn() {
    const bargeInEvent: EventEntityBargeIn = {
      type: "barge_in",
      data: {},
    };
    const message = this.createMessage("event", {
      entities: [bargeInEvent],
    } as SelectParametersForType<"event", EventParameters>);

    this.buffer.length = 0; // Clear buffer on barge-in
    console.log(`${getISTTime()}:[Session] Sending barge-in`);
    this.send(message);
  }

  sendTurnResponse(
    disposition: BotTurnDisposition,
    text: string | undefined,
    confidence: number | undefined
  ) {
    const botTurnResponseEvent: EventEntityBotTurnResponse = {
      type: "bot_turn_response",
      data: {
        disposition,
        text,
        confidence,
      },
    };
    const message = this.createMessage("event", {
      entities: [botTurnResponseEvent],
    } as SelectParametersForType<"event", EventParameters>);

    console.log(
      `${getISTTime()}:[Session] Sending bot response: ${disposition} - ${text}`
    );
    this.send(message);
  }

  sendTranscript(transcript: string, confidence: number, isFinal: boolean) {
    const channel = this.selectedMedia?.channels[0];
    if (!channel) {
      console.log(`${getISTTime()}:[Session] No channel for transcript`);
      return;
    }

    const parameters: EventEntityDataTranscript = {
      id: uuid(),
      channel,
      isFinal,
      alternatives: [
        {
          confidence,
          interpretations: [
            {
              type: "normalized",
              transcript,
            },
          ],
        },
      ],
    };

    const transcriptEvent: EventEntityTranscript = {
      type: "transcript",
      data: parameters,
    };

    const message = this.createMessage("event", {
      entities: [transcriptEvent],
    } as SelectParametersForType<"event", EventParameters>);

    console.log(
      `${getISTTime()}:[Session] Transcript: "${transcript}" (final: ${isFinal})`
    );
    this.send(message);
  }

  sendDisconnect(
    reason: DisconnectReason,
    info: string,
    outputVariables: JsonStringMap
  ) {
    this.disconnecting = true;
    console.log(`${getISTTime()}:[Session] Disconnecting: ${reason} - ${info}`);

    const disconnectParameters: DisconnectParameters = {
      reason,
      info,
      outputVariables,
    };
    const message = this.createMessage("disconnect", disconnectParameters);
    this.send(message);
  }

  sendClosed() {
    const message = this.createMessage("closed", {});
    console.log(`${getISTTime()}:[Session] Sending closed`);
    this.send(message);
  }

  sendKeepAlive() {
    console.log(`${getISTTime()}:[Session] Sending keep-alive`);
    this.send(this.createMessage("pong", {}));
    this.voiceAIAgentClient?.sendKeepAlive();
  }

  // Handle UltraVox audio responses (OUTBOUND to Genesys)
  sendAudioFromAgent(audioData: Uint8Array) {
    if (this.closed) {
      console.log(
        `${getISTTime()}:[Session] Cannot send agent audio - session closed`
      );
      return;
    }

    console.log(
      `${getISTTime()}:[Session] Received AGENT audio from UltraVox: ${
        audioData.length
      } bytes -> sending to Genesys customer`
    );

    // Use existing sendAudio method for buffering/chunking
    this.sendAudio(audioData);
  }

  // Clarify this processes customer audio TO UltraVox
  processBinaryMessage(data: Uint8Array) {
    if (this.disconnecting || this.closed) {
      console.log(`${getISTTime()}:[Session] Ignoring audio - session closing`);
      return;
    }

    if (this.isCapturingDTMF) {
      console.log(`${getISTTime()}:[Session] Ignoring audio - capturing DTMF`);
      return;
    }

    if (!this.voiceAIAgentClient) {
      console.log(
        `${getISTTime()}:[Session] Ignoring audio - voice agent not initialized yet (waiting for 'open' message)`
      );
      return;
    }

    console.log(
      `${getISTTime()}:[Session] Processing CUSTOMER audio from Genesys: ${
        data.length
      } bytes -> sending to UltraVox`
    );

    // Send customer audio TO UltraVox agent
    this.voiceAIAgentClient.processAudio(data);
  }

  // DTMF processing
  processDTMF(digit: string) {
    if (this.disconnecting || this.closed) {
      console.log(`${getISTTime()}:[Session] Ignoring DTMF - session closing`);
      return;
    }

    if (this.isAudioPlaying) {
      console.log(`${getISTTime()}:[Session] Ignoring DTMF - audio playing`);
      this.dtmfService = null;
      return;
    }

    if (!this.isCapturingDTMF) {
      this.isCapturingDTMF = true;
      console.log(`${getISTTime()}:[Session] Started DTMF capture`);
    }

    if (!this.dtmfService || this.dtmfService.getState() === "Complete") {
      this.dtmfService = new DTMFService()
        .on("error", (error: any) => {
          const message = "Error during DTMF Capture.";
          console.log(`${getISTTime()}:[Session] DTMF error: ${error}`);
          this.sendDisconnect("error", message, {});
        })
        .on("final-digits", (digits: any) => {
          this.sendTranscript(digits, 1.0, true);
          console.log(`${getISTTime()}:[Session] DTMF captured: ${digits}`);
          this.isCapturingDTMF = false;
        });

      console.log(`${getISTTime()}:[Session] DTMF service initialized`);
    }

    console.log(`${getISTTime()}:[Session] Processing DTMF: ${digit}`);
    this.dtmfService.processDigit(digit);
  }
}
