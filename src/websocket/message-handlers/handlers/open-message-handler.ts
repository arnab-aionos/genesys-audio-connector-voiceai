import { MediaParameter } from "../../../protocol/core";
import {
  ClientMessage,
  OpenMessage,
  ServerMessage,
} from "../../../protocol/message";
import { Session } from "../../session";
import { MessageHandler } from "../message-handler";

export class OpenMessageHandler implements MessageHandler {
  handleMessage(message: ClientMessage, session: Session) {
    const parsedMessage: OpenMessage = message as OpenMessage;

    if (!parsedMessage) {
      const message = "Invalid request parameters.";
      console.log(`${new Date().toISOString()}:[OpenHandler] ${message}`);
      session.sendDisconnect("error", message, {});
      return;
    }

    session.setConversationId(parsedMessage.parameters.conversationId);
    console.log(
      `${new Date().toISOString()}:[OpenHandler] Received Open Message for conversation: ${
        parsedMessage.parameters.conversationId
      }`
    );

    let selectedMedia: MediaParameter | null = null;

    // Find supported media format (PCMU 8kHz)
    parsedMessage.parameters.media.forEach((element: MediaParameter) => {
      if (element.format === "PCMU" && element.rate === 8000) {
        selectedMedia = element;
      }
    });

    if (!selectedMedia) {
      const message = "No supported media type was found.";
      console.log(`${new Date().toISOString()}:[OpenHandler] ${message}`);
      session.sendDisconnect("error", message, {});
      return;
    }

    console.log(
      `${new Date().toISOString()}:[OpenHandler] Using MediaParameter: ${JSON.stringify(
        selectedMedia
      )}`
    );
    session.setSelectedMedia(selectedMedia);

    // Set input variables if provided
    if (parsedMessage.parameters.inputVariables) {
      console.log(
        `${new Date().toISOString()}:[OpenHandler] Setting input variables: ${JSON.stringify(
          parsedMessage.parameters.inputVariables
        )}`
      );
      session.setInputVariables(parsedMessage.parameters.inputVariables);
    }

    // CRITICAL: Send "opened" response back to Genesys
    if (selectedMedia) {
      const response: ServerMessage = session.createMessage("opened", {
        media: [selectedMedia],
      });

      console.log(
        `${new Date().toISOString()}:[OpenHandler] Sending opened response to Genesys`
      );
      session.send(response);

      // The UltraVox agent will be initialized in the Session constructor
      // and will automatically start the conversation
    }
  }
}
