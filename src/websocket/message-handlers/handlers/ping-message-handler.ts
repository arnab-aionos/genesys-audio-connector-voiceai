import { ClientMessage } from "../../../protocol/message";
import { Session } from "../../session";
import { MessageHandler } from "../message-handler";
import { getISTTime } from "../../../common/environment-variables";

export class PingMessageHandler implements MessageHandler {
  handleMessage(message: ClientMessage, session: Session) {
    console.log(`${getISTTime()}:[PingHandler] Received ping message`);
    // Send keep-alive to both Genesys and UltraVox
    session.sendKeepAlive();
  }
}
