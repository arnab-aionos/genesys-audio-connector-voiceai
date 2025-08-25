import {
  Duration,
  EventEntityBase,
  MediaChannel,
  LanguageCode,
  Uuid,
} from "./core";

export type EventEntityTranscript = EventEntityBase<
  "transcript",
  EventEntityDataTranscript
>;

export type EventEntityDataTranscript = {
  id: Uuid;
  channel: MediaChannel;
  isFinal: boolean;
  position?: Duration;
  duration?: Duration;
  alternatives: TranscriptAlternative[];
};

export type TranscriptAlternative = {
  confidence: number;
  languages?: LanguageCode[];
  interpretations: TranscriptInterpretation[];
};

export type TranscriptInterpretationType = "lexical" | "normalized";

export type TranscriptInterpretation = {
  type: TranscriptInterpretationType;
  transcript: string;
  tokens?: TranscriptToken[];
};

export type TranscriptTokenType = "word" | "punctuation";

export type TranscriptToken = {
  type: TranscriptTokenType;
  value: string;
  confidence: number;
  position: Duration;
  duration: Duration;
  language?: LanguageCode;
};
