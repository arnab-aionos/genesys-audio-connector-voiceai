import { VoiceAIAgentBaseClass } from "./voice-aiagent-base";
import { UltraVoxAgent } from "./ultravox-agent";
import { Session } from "../websocket/session";

export class VoiceAIAgentFactory {
  static create(agentName: string, session: Session): VoiceAIAgentBaseClass {
    const name = (agentName || "UltraVox").toLowerCase();

    console.log(
      `${new Date().toISOString()}:[VoiceAIAgentFactory] Creating agent: ${name}`
    );

    switch (name) {
      case "ultravox":
        return new UltraVoxAgent(session);

      default:
        console.error(
          `${new Date().toISOString()}:[VoiceAIAgentFactory] Unknown agent: ${agentName}`
        );
        throw new Error(
          `[VoiceAIAgentFactory] Unsupported agent: ${agentName}. Only 'ultravox' is supported.`
        );
    }
  }

  static getSupportedProviders(): string[] {
    return ["ultravox"];
  }

  static isProviderSupported(providerName: string): boolean {
    return this.getSupportedProviders().includes(providerName.toLowerCase());
  }
}
