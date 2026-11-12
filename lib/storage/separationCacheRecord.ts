import type { SeparatedStemSet, StemSeparationMode, StemType } from "../separation/stemTypes";

type CachedStemTrack = {
  stemType: StemType;
  left: ArrayBuffer;
  right: ArrayBuffer;
};

export type StemCacheRecord = {
  key: string;
  sourceAudioHash: string;
  modelVersion: string;
  processingVersion: string;
  mode: StemSeparationMode;
  sampleRate: number;
  channels: number;
  createdAt: number;
  sizeBytes: number;
  tracks: CachedStemTrack[];
};

export function createStemCacheRecord(input: {
  key: string;
  sourceAudioHash: string;
  modelVersion: string;
  processingVersion?: string;
  stems: SeparatedStemSet;
  createdAt?: number;
}): StemCacheRecord {
  const tracks = input.stems.tracks.map((track) => ({
    stemType: track.stemType,
    left: track.left.slice().buffer as ArrayBuffer,
    right: track.right.slice().buffer as ArrayBuffer,
  }));
  return {
    key: input.key,
    sourceAudioHash: input.sourceAudioHash,
    modelVersion: input.modelVersion,
    processingVersion: input.processingVersion ?? "1",
    mode: input.stems.mode,
    sampleRate: input.stems.sampleRate,
    channels: 2,
    createdAt: input.createdAt ?? Date.now(),
    sizeBytes: tracks.reduce((total, track) => total + track.left.byteLength + track.right.byteLength, 0),
    tracks,
  };
}

export function restoreStemSet(record: StemCacheRecord): SeparatedStemSet {
  return {
    mode: record.mode,
    sampleRate: record.sampleRate,
    tracks: record.tracks.map((track) => ({
      stemType: track.stemType,
      left: new Float32Array(track.left.slice(0)),
      right: new Float32Array(track.right.slice(0)),
    })),
  };
}
