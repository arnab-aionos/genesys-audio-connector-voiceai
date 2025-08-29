import WebSocket from "ws";

interface AudioMessage {
  id: string;
  version: string;
  seq: number;
  serverseq: number;
  type: string;
  parameters: any;
}

class AudioTester {
  private ws: WebSocket | null = null;
  private audioReceived: Buffer[] = [];
  private messagesReceived: AudioMessage[] = [];

  async connect() {
    console.log("Connecting to local server...");

    // Connect to localhost with test headers
    // this.ws = new WebSocket("ws://localhost:5000", {
    //   headers: {
    //     "X-API-KEY":
    //       "gx_4k8n2m9p6r3s7t1v5w8x2y4z6a9b3c7d1e5f8g2h6i0j4k7l1m9n3o6p2q8r5s1t7u4v0w6x9y3z8",
    //     "audiohook-session-id": "test-audio-session-123",
    //     "audiohook-organization-id": "test-org-456",
    //     "audiohook-correlation-id": "test-correlation-789",
    //   },
    // });

    this.ws = new WebSocket("wss://genesys.aionos.co/", {
      headers: {
        "X-API-KEY":
          "gx_4k8n2m9p6r3s7t1v5w8x2y4z6a9b3c7d1e5f8g2h6i0j4k7l1m9n3o6p2q8r5s1t7u4v0w6x9y3z8",
        "audiohook-session-id": "test-audio-session-123",
        "audiohook-organization-id": "test-org-456",
        "audiohook-correlation-id": "test-correlation-789",
      },
    });

    this.ws.on("open", () => {
      console.log("WebSocket connected");
      this.sendOpenMessage();
    });

    this.ws.on("message", (data: WebSocket.RawData) => {
      if (typeof data === "string" || data.toString().startsWith("{")) {
        const message = JSON.parse(data.toString()) as AudioMessage;
        console.log(`Received message: ${message.type}`);
        this.messagesReceived.push(message);

        if (message.type === "opened") {
          console.log("Handshake complete - starting audio test...");
          setTimeout(() => this.startAudioTest(), 1000);
        }

        if (
          message.type === "event" &&
          message.parameters?.entities?.[0]?.type === "transcript"
        ) {
          const transcript =
            message.parameters.entities[0].data.alternatives[0]
              .interpretations[0].transcript;
          console.log(`TRANSCRIPT: "${transcript}"`);
        }
      } else {
        // Binary audio data
        this.audioReceived.push(data as Buffer);
        console.log(
          `Received audio: ${(data as Buffer).length} bytes (total: ${
            this.audioReceived.length
          } chunks)`
        );
      }
    });

    this.ws.on("close", () => {
      console.log("Connection closed");
      this.printResults();
    });

    this.ws.on("error", (error: Error) => {
      console.log("Error:", error.message);
    });
  }

  private sendOpenMessage() {
    const openMsg: AudioMessage = {
      id: "test-audio-session-123",
      version: "2",
      seq: 1,
      serverseq: 0,
      type: "open",
      parameters: {
        conversationId: "test-audio-conversation-456",
        media: [
          {
            format: "PCMU",
            rate: 8000,
            channels: ["customer", "agent"],
          },
        ],
        inputVariables: {
          systemPrompt:
            "You are a test assistant. Say hello and ask how you can help.",
        },
      },
    };

    console.log("Sending open message...");
    this.ws?.send(JSON.stringify(openMsg));
  }

  private startAudioTest() {
    console.log("Starting audio stream test...");

    // Generate test audio: alternating patterns to simulate speech
    const testDuration = 3000; // 3 seconds
    const chunkSize = 160; // 20ms chunks at 8kHz
    const chunksPerSecond = 50; // 1000ms / 20ms
    const totalChunks = (testDuration / 1000) * chunksPerSecond;

    let chunksSent = 0;

    const audioInterval = setInterval(() => {
      if (chunksSent >= totalChunks) {
        clearInterval(audioInterval);
        console.log("Audio stream complete");
        setTimeout(() => {
          console.log("Closing connection...");
          this.ws?.close();
        }, 2000);
        return;
      }

      // Create test audio pattern (simulates varying audio levels)
      const audioChunk = Buffer.alloc(chunkSize);
      for (let i = 0; i < chunkSize; i++) {
        // Create sine wave pattern in PCMU format
        const sample = Math.sin((chunksSent * chunkSize + i) * 0.1) * 50 + 128;
        audioChunk[i] = Math.floor(sample);
      }

      this.ws?.send(audioChunk);
      chunksSent++;

      if (chunksSent % 50 === 0) {
        // Every second
        console.log(`Sent ${chunksSent}/${totalChunks} audio chunks`);
      }
    }, 20); // 20ms intervals
  }

  private printResults() {
    console.log("\nTEST RESULTS:");
    console.log("================");
    console.log(`Messages received: ${this.messagesReceived.length}`);
    console.log(`Audio chunks received: ${this.audioReceived.length}`);

    const totalAudioBytes = this.audioReceived.reduce(
      (sum, chunk) => sum + chunk.length,
      0
    );
    console.log(`Total audio data: ${totalAudioBytes} bytes`);

    console.log("\nMessage types received:");
    this.messagesReceived.forEach((msg) => {
      console.log(`- ${msg.type}`);
    });

    console.log("\nSUCCESS CRITERIA:");
    console.log(
      `WebSocket connection: ${
        this.messagesReceived.length > 0 ? "PASS" : "FAIL"
      }`
    );
    console.log(
      `Handshake (opened): ${
        this.messagesReceived.some((m) => m.type === "opened") ? "PASS" : "FAIL"
      }`
    );
    console.log(
      `UltraVox audio output: ${
        this.audioReceived.length > 0 ? "PASS" : "FAIL"
      }`
    );
    console.log(
      `Bidirectional audio: ${totalAudioBytes > 1000 ? "PASS" : "FAIL"}`
    );

    const hasTranscripts = this.messagesReceived.some(
      (m) =>
        m.type === "event" && m.parameters?.entities?.[0]?.type === "transcript"
    );
    console.log(`Speech processing: ${hasTranscripts ? "PASS" : "FAIL"}`);
  }
}

// Run the test
console.log("Starting Audio Connector Test");
console.log("================================");

const tester = new AudioTester();
tester.connect();

// Auto-exit after 30 seconds
setTimeout(() => {
  console.log("\nTest timeout - closing...");
  process.exit(0);
}, 30000);
