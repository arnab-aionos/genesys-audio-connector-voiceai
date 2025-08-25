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
} from "../common/environment-variables";

import dotenv from "dotenv";
dotenv.config();

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

  constructor(ws: WebSocket, sessionId: string, url: string) {
    this.ws = ws;
    this.clientSessionId = sessionId;
    this.url = url;

    console.log(
      `${new Date().toISOString()}:[Session] Created session: ${
        this.clientSessionId
      }`
    );

    // Initialize Voice AI Agent
    try {
      this.voiceAIAgentClient = VoiceAIAgentFactory.create(BOT_PROVIDER, this);
      console.log(
        `${new Date().toISOString()}:[Session] Voice AI Agent initialized: ${BOT_PROVIDER}`
      );
    } catch (error) {
      console.error(
        `${new Date().toISOString()}:[Session] Failed to initialize Voice AI Agent:`,
        error
      );
    }
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
      console.log(`${new Date().toISOString()}:[Session] Already closed`);
      return;
    }

    try {
      console.log(
        `${new Date().toISOString()}:[Session] Closing session: ${
          this.clientSessionId
        }`
      );

      // Close Voice AI Agent first
      this.voiceAIAgentClient?.close();

      // Close WebSocket
      this.ws.close();
    } catch (error) {
      console.error(
        `${new Date().toISOString()}:[Session] Error closing:`,
        error
      );
    }

    this.closed = true;
    console.log(
      `${new Date().toISOString()}:[Session] Session closed: ${
        this.clientSessionId
      }`
    );
  }

  setConversationId(conversationId: string) {
    this.conversationId = conversationId;
    console.log(
      `${new Date().toISOString()}:[Session] Conversation ID: ${conversationId}`
    );
  }

  setInputVariables(inputVariables: JsonStringMap) {
    this.inputVariables = inputVariables;
    console.log(
      `${new Date().toISOString()}:[Session] Input variables:`,
      JSON.stringify(inputVariables)
    );
  }

  setSelectedMedia(selectedMedia: MediaParameter) {
    this.selectedMedia = selectedMedia;
    console.log(
      `${new Date().toISOString()}:[Session] Media:`,
      JSON.stringify(selectedMedia)
    );
  }

  setIsAudioPlaying(isAudioPlaying: boolean) {
    this.isAudioPlaying = isAudioPlaying;
    console.log(
      `${new Date().toISOString()}:[Session] Audio playing: ${isAudioPlaying}`
    );
  }

  playbackCompleted() {
    console.log(`${new Date().toISOString()}:[Session] Playback completed`);
    this.setIsAudioPlaying(false);
    this.voiceAIAgentClient?.processPlaybackCompleted();
  }

  processTextMessage(data: string) {
    if (this.closed) {
      console.log(
        `${new Date().toISOString()}:[Session] Ignoring text message - session closed`
      );
      return;
    }

    try {
      const message = JSON.parse(data);
      console.log(
        `${new Date().toISOString()}:[Session] Processing message: ${
          message.type
        }`
      );

      // Validate sequence numbers
      if (message.seq !== this.lastClientSequenceNumber + 1) {
        console.log(
          `${new Date().toISOString()}:[Session] Invalid client sequence: ${
            message.seq
          }`
        );
        this.sendDisconnect("error", "Invalid client sequence number.", {});
        return;
      }

      this.lastClientSequenceNumber = message.seq;

      if (message.serverseq > this.lastServerSequenceNumber) {
        console.log(
          `${new Date().toISOString()}:[Session] Invalid server sequence: ${
            message.serverseq
          }`
        );
        this.sendDisconnect("error", "Invalid server sequence number.", {});
        return;
      }

      if (message.id !== this.clientSessionId) {
        console.log(
          `${new Date().toISOString()}:[Session] Invalid session ID: ${
            message.id
          }`
        );
        this.sendDisconnect("error", "Invalid ID specified.", {});
        return;
      }

      const handler = this.messageHandlerRegistry.getHandler(message.type);
      if (!handler) {
        console.log(
          `${new Date().toISOString()}:[Session] No handler for: ${
            message.type
          }`
        );
        return;
      }

      handler.handleMessage(message as ClientMessage, this);
    } catch (error) {
      console.error(
        `${new Date().toISOString()}:[Session] Error processing text message:`,
        error
      );
      this.sendDisconnect("error", "Message processing error", {});
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
      console.log(
        `${new Date().toISOString()}:[Session] Cannot send - session closed`
      );
      return;
    }

    if (message.type === "event") {
      console.log(
        `${new Date().toISOString()}:[Session] Sending event: ${
          message.parameters.entities[0].type
        }`
      );
    } else {
      console.log(
        `${new Date().toISOString()}:[Session] Sending: ${message.type}`
      );
    }

    this.ws.send(JSON.stringify(message));
  }

  flushBuffer() {
    const totalLength =
      this.buffer?.reduce((acc, curr) => acc + curr.length, 0) || 0;
    if (totalLength <= 0) {
      console.log(
        `${new Date().toISOString()}:[Session] Buffer empty - nothing to flush`
      );
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
        `${new Date().toISOString()}:[Session] Cannot send audio - session closed`
      );
      return;
    }

    this.buffer.push(currBytes);
    const totalLength =
      this.buffer?.reduce((acc, curr) => acc + curr.length, 0) || 0;

    if (totalLength < this.MIN_BINARY_MESSAGE_SIZE) {
      console.log(
        `${new Date().toISOString()}:[Session] Buffering audio (${totalLength}/${
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
        `${new Date().toISOString()}:[Session] Sending audio: ${
          bytes.length
        } bytes`
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
          `${new Date().toISOString()}:[Session] Sending chunk ${++chunkCount}: ${
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
    console.log(`${new Date().toISOString()}:[Session] Sending barge-in`);
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
      `${new Date().toISOString()}:[Session] Sending bot response: ${disposition} - ${text}`
    );
    this.send(message);
  }

  sendTranscript(transcript: string, confidence: number, isFinal: boolean) {
    const channel = this.selectedMedia?.channels[0];
    if (!channel) {
      console.log(
        `${new Date().toISOString()}:[Session] No channel for transcript`
      );
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
      `${new Date().toISOString()}:[Session] Transcript: "${transcript}" (final: ${isFinal})`
    );
    this.send(message);
  }

  sendDisconnect(
    reason: DisconnectReason,
    info: string,
    outputVariables: JsonStringMap
  ) {
    this.disconnecting = true;
    console.log(
      `${new Date().toISOString()}:[Session] Disconnecting: ${reason} - ${info}`
    );

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
    console.log(`${new Date().toISOString()}:[Session] Sending closed`);
    this.send(message);
  }

  sendKeepAlive() {
    console.log(`${new Date().toISOString()}:[Session] Sending keep-alive`);
    this.send(this.createMessage("pong", {}));
    this.voiceAIAgentClient?.sendKeepAlive();
  }

  // Audio processing - main entry point for Genesys audio
  processBinaryMessage(data: Uint8Array) {
    if (this.disconnecting || this.closed) {
      console.log(
        `${new Date().toISOString()}:[Session] Ignoring audio - session closing`
      );
      return;
    }

    if (this.isCapturingDTMF) {
      console.log(
        `${new Date().toISOString()}:[Session] Ignoring audio - capturing DTMF`
      );
      return;
    }

    console.log(
      `${new Date().toISOString()}:[Session] Processing audio: ${
        data.length
      } bytes`
    );

    // Send directly to Voice AI Agent (UltraVox)
    this.voiceAIAgentClient?.processAudio(data);
  }

  // DTMF processing
  processDTMF(digit: string) {
    if (this.disconnecting || this.closed) {
      console.log(
        `${new Date().toISOString()}:[Session] Ignoring DTMF - session closing`
      );
      return;
    }

    if (this.isAudioPlaying) {
      console.log(
        `${new Date().toISOString()}:[Session] Ignoring DTMF - audio playing`
      );
      this.dtmfService = null;
      return;
    }

    if (!this.isCapturingDTMF) {
      this.isCapturingDTMF = true;
      console.log(`${new Date().toISOString()}:[Session] Started DTMF capture`);
    }

    if (!this.dtmfService || this.dtmfService.getState() === "Complete") {
      this.dtmfService = new DTMFService()
        .on("error", (error: any) => {
          const message = "Error during DTMF Capture.";
          console.log(
            `${new Date().toISOString()}:[Session] DTMF error: ${error}`
          );
          this.sendDisconnect("error", message, {});
        })
        .on("final-digits", (digits: any) => {
          this.sendTranscript(digits, 1.0, true);
          console.log(
            `${new Date().toISOString()}:[Session] DTMF captured: ${digits}`
          );
          this.isCapturingDTMF = false;
        });

      console.log(
        `${new Date().toISOString()}:[Session] DTMF service initialized`
      );
    }

    console.log(
      `${new Date().toISOString()}:[Session] Processing DTMF: ${digit}`
    );
    this.dtmfService.processDigit(digit);
  }
}
