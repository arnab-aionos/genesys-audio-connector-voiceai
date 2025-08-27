import { MediaParameter } from "../../../protocol/core";
import {
  ClientMessage,
  OpenMessage,
  ServerMessage,
} from "../../../protocol/message";
import { Session } from "../../session";
import { MessageHandler } from "../message-handler";
import { getISTTime } from "../../../common/environment-variables";

export class OpenMessageHandler implements MessageHandler {
  handleMessage(message: ClientMessage, session: Session) {
    const parsedMessage: OpenMessage = message as OpenMessage;

    if (!parsedMessage) {
      const message = "Invalid request parameters.";
      console.log(`${getISTTime()}:[OpenHandler] ${message}`);
      session.sendDisconnect("error", message, {});
      return;
    }

    session.setConversationId(parsedMessage.parameters.conversationId);
    console.log(
      `${getISTTime()}:[OpenHandler] Received Open Message for conversation: ${
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
      console.log(`${getISTTime()}:[OpenHandler] ${message}`);
      session.sendDisconnect("error", message, {});
      return;
    }

    console.log(
      `${getISTTime()}:[OpenHandler] Using MediaParameter: ${JSON.stringify(
        selectedMedia
      )}`
    );
    session.setSelectedMedia(selectedMedia);

    // Set input variables if provided
    if (parsedMessage.parameters.inputVariables) {
      console.log(
        `${getISTTime()}:[OpenHandler] Setting input variables: ${JSON.stringify(
          parsedMessage.parameters.inputVariables
        )}`
      );
      session.setInputVariables(parsedMessage.parameters.inputVariables);
    }

    // STEP 1: Send "opened" response back to Genesys FIRST
    if (selectedMedia) {
      const response: ServerMessage = session.createMessage("opened", {
        media: [selectedMedia],
      });

      console.log(
        `${getISTTime()}:[OpenHandler] Sending 'opened' response to Genesys`
      );
      session.send(response);

      // STEP 2: ONLY NOW initialize UltraVox after successful Genesys handshake
      console.log(
        `${getISTTime()}:[OpenHandler] Genesys handshake complete - now initializing UltraVox`
      );
      session.initializeVoiceAgent();
    }
  }
}
