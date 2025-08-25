import { ClientMessage } from "../../protocol/message";
import { Session } from "../session";

export interface MessageHandler {
  handleMessage(message: ClientMessage, session: Session): void;
}
