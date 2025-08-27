import { VoiceAIAgentBaseClass } from "./voice-aiagent-base";
import { UltraVoxAgent } from "./ultravox-agent";
import { Session } from "../websocket/session";
import { getISTTime } from "../common/environment-variables";

export class VoiceAIAgentFactory {
  static create(agentName: string, session: Session): VoiceAIAgentBaseClass {
    const name = (agentName || "UltraVox").toLowerCase();

    console.log(
      `${getISTTime()}:[VoiceAIAgentFactory] Creating agent: ${name}`
    );

    switch (name) {
      case "ultravox":
        return new UltraVoxAgent(session);

      default:
        console.error(
          `${getISTTime()}:[VoiceAIAgentFactory] Unknown agent: ${agentName}`
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
