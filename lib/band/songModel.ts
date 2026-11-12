import type { BandSong, StemChannel } from "./bandTypes";

type CreateBandSongInput = {
  id: string;
  name: string;
  fileName?: string;
  sourceAudioId: string;
  settingsKey?: string;
  originalBpm: number;
  durationSec?: number;
};

export function createBandSong(input: CreateBandSongInput): BandSong {
  return {
    id: input.id,
    settingsKey: input.settingsKey ?? input.sourceAudioId,
    name: input.name,
    fileName: input.fileName ?? input.name,
    originalBpm: input.originalBpm,
    targetBpm: input.originalBpm,
    keyShiftSemitones: 0,
    tempoMode: "target-bpm",
    manualRate: 1,
    fineRateOffset: 0,
    savedRates: [1],
    masterVolume: 1,
    playheadSec: 0,
    durationSec: input.durationSec ?? 0,
    status: "stopped",
    loop: false,
    selected: false,
    sourceAudioId: input.sourceAudioId,
    stemIds: [],
    stemChannels: [],
    separationStatus: "not_started",
    separationMode: null,
    separationProgress: 0,
    separationMessage: "",
    playbackSource: "original",
    cacheKey: null,
  };
}

export function getEffectivePlaybackRate(song: Pick<BandSong,
  "tempoMode" | "targetBpm" | "originalBpm" | "manualRate" | "fineRateOffset"
>): number {
  const coarse = song.tempoMode === "manual-rate"
    ? song.manualRate
    : song.targetBpm / Math.max(1, song.originalBpm);
  return Math.max(0.25, Math.min(4, coarse + song.fineRateOffset));
}

export function getSongPlaybackTrackIds(song: Pick<BandSong, "playbackSource" | "sourceAudioId" | "stemIds">): string[] {
  return song.playbackSource === "stems" && song.stemIds.length > 0
    ? [...song.stemIds]
    : [song.sourceAudioId];
}

export function getStemAudibility(channels: Array<Pick<StemChannel, "id" | "muted" | "solo">>): Record<string, boolean> {
  const hasSolo = channels.some((channel) => channel.solo);
  return Object.fromEntries(channels.map((channel) => [
    channel.id,
    !channel.muted && (!hasSolo || channel.solo),
  ]));
}

export function serializeSongSettings(song: BandSong) {
  return {
    songId: song.id,
    targetBpm: song.targetBpm,
    keyShiftSemitones: song.keyShiftSemitones,
    masterVolume: song.masterVolume,
    tempoMode: song.tempoMode,
    manualRate: song.manualRate,
    fineRateOffset: song.fineRateOffset,
    savedRates: [...song.savedRates],
    loop: song.loop,
    separationMode: song.separationMode,
    stemVolumes: Object.fromEntries(song.stemChannels.map((channel) => [channel.stemType, channel.volume])),
    stemMuted: Object.fromEntries(song.stemChannels.map((channel) => [channel.stemType, channel.muted])),
    stemSolo: Object.fromEntries(song.stemChannels.map((channel) => [channel.stemType, channel.solo])),
  };
}
