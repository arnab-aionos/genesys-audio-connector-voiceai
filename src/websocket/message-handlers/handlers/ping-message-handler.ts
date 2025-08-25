import { ClientMessage } from "../../../protocol/message";
import { Session } from "../../session";
import { MessageHandler } from "../message-handler";

export class PingMessageHandler implements MessageHandler {
  handleMessage(message: ClientMessage, session: Session) {
    console.log(
      `${new Date().toISOString()}:[PingHandler] Received ping message`
    );
    // Send keep-alive to both Genesys and UltraVox
    session.sendKeepAlive();
  }
}
