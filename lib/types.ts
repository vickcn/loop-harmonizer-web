export type SectionType = {
  id: string;
  name: string;
  color: string;
};

export type SectionInstance = {
  id: string;
  typeId: string;
  label: string;
  startBar: number;
  endBar: number;
};

export type TempoAnchor = {
  id: string;
  bar: number;
  bpm: number;
};

export type TempoSegmentMode = "hold" | "linear";

export type TempoSegment = {
  id: string;
  fromAnchorId: string;
  toAnchorId: string;
  mode: TempoSegmentMode;
};

export type AudioSourceMeta = {
  id: string;
  fileName: string;
  detectedBpm?: number;
  userConfirmedBpm?: number;
  bpmConfidence?: number;
};

export type SongTimeline = {
  id: string;
  name: string;
  /** 此流程 / 專案預設 BPM，timeline anchor 的參考中心 */
  projectBpm: number;
  /** 音檔本身的 meta，userConfirmedBpm 決定 tempoRatio 分母 */
  audioSource: AudioSourceMeta;
  totalBars: number;
  timeSignature: {
    beatsPerBar: number;
    beatUnit: number;
  };
  sectionTypes: SectionType[];
  sections: SectionInstance[];
  tempoAnchors: TempoAnchor[];
  tempoSegments: TempoSegment[];
};

export type BeatAnalyzeRequest = {
  songId: string;
  sectionId?: string;
  requiredTaps: number;
  tapTimes: number[];
  rawDetectedBpm: number | null;
  currentTimelineBpm: number;
};

export type BeatAnalyzeResponse = {
  suggestedBpm: number;
  confidence: number;
  transition: {
    mode: "linear";
    beats: number;
  };
};
