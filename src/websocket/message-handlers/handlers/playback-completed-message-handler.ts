import { ClientMessage } from "../../../protocol/message";
import { Session } from "../../session";
import { MessageHandler } from "../message-handler";
import { getISTTime } from "../../../common/environment-variables";

export class PlaybackCompletedMessageHandler implements MessageHandler {
  handleMessage(message: ClientMessage, session: Session) {
    console.log(
      `${getISTTime()}:[PlaybackHandler] Received Playback Completed Message`
    );
    // Call the session's playbackCompleted method which handles the agent notification
    session.playbackCompleted();
  }
}
