import { ClientMessage } from "../../../protocol/message";
import { Session } from "../../session";
import { MessageHandler } from "../message-handler";

export class PlaybackCompletedMessageHandler implements MessageHandler {
  handleMessage(message: ClientMessage, session: Session) {
    console.log(
      `${new Date().toISOString()}:[PlaybackHandler] Received Playback Completed Message`
    );
    // Call the session's playbackCompleted method which handles the agent notification
    session.playbackCompleted();
  }
}
