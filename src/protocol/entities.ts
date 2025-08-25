import { EventEntityBase, JsonValue } from "./core";
import { EventEntityBargeIn, EventEntityBotTurnResponse } from "./voice-bots";
import { EventEntityTranscript } from "./entities-transcript"; // UNCOMMENTED

export type EventEntityPredefined =
  | EventEntityTranscript // ADDED BACK
  | EventEntityBargeIn
  | EventEntityBotTurnResponse;

export type EventEntity =
  | EventEntityPredefined
  | EventEntityBase<string, JsonValue>;

export type EventEntities = EventEntity[];
