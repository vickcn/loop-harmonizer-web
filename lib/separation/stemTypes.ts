export type StemSeparationMode = "two_stem" | "four_stem";

export type StemType = "vocals" | "instrumental" | "drums" | "bass" | "other";

export type StereoPcm = {
  left: Float32Array;
  right: Float32Array;
};

export type FourStemPcm = {
  vocals: StereoPcm;
  drums: StereoPcm;
  bass: StereoPcm;
  other: StereoPcm;
};

export type SeparatedStem = StereoPcm & {
  stemType: StemType;
};

export type SeparatedStemSet = {
  mode: StemSeparationMode;
  sampleRate: number;
  tracks: SeparatedStem[];
};

export type StemMetadata = {
  sourceGroupId: string;
  stemType: StemType;
  sourceFileName: string;
};

export type StemTrackDescriptor = {
  id: string;
  name: string;
  fileName: string;
  originalBpm: number;
  coarseRate: number;
  baseRate: number;
  savedRates: number[];
  volume: number;
  muted: boolean;
  selected: boolean;
  playheadSec: number;
  durationSec: number;
  status: "stopped";
  syncMode: "global-bpm";
  loop: boolean;
  playbackMode: "soundtouch";
  keyShiftSemitones: number;
  followsGlobalKey: true;
  stemMetadata: StemMetadata;
};

function sumChannels(channels: Float32Array[]): Float32Array {
  const output = new Float32Array(channels[0]?.length ?? 0);
  for (const channel of channels) {
    for (let index = 0; index < output.length; index += 1) {
      output[index] += channel[index] ?? 0;
    }
  }
  return output;
}

export function buildSeparatedStemSet(
  result: FourStemPcm,
  sampleRate: number,
  mode: StemSeparationMode,
): SeparatedStemSet {
  if (mode === "two_stem") {
    return {
      mode,
      sampleRate,
      tracks: [
        { stemType: "vocals", ...result.vocals },
        {
          stemType: "instrumental",
          left: sumChannels([result.drums.left, result.bass.left, result.other.left]),
          right: sumChannels([result.drums.right, result.bass.right, result.other.right]),
        },
      ],
    };
  }

  return {
    mode,
    sampleRate,
    tracks: [
      { stemType: "vocals", ...result.vocals },
      { stemType: "drums", ...result.drums },
      { stemType: "bass", ...result.bass },
      { stemType: "other", ...result.other },
    ],
  };
}

const STEM_LABELS: Record<StemType, string> = {
  vocals: "人聲",
  instrumental: "伴奏",
  drums: "鼓組",
  bass: "貝斯",
  other: "其他",
};

export function createStemTrackDescriptors(
  stems: SeparatedStemSet,
  sourceFileName: string,
  sourceGroupId: string,
  createTrackId: (stemType: StemType) => string,
): StemTrackDescriptor[] {
  const sourceName = sourceFileName.replace(/\.[^.]+$/, "");

  return stems.tracks.map((stem) => ({
    id: createTrackId(stem.stemType),
    name: `${sourceName} · ${STEM_LABELS[stem.stemType]}`,
    fileName: sourceFileName,
    originalBpm: 120,
    coarseRate: 1,
    baseRate: 1,
    savedRates: [1],
    volume: 1,
    muted: false,
    selected: true,
    playheadSec: 0,
    durationSec: stem.left.length / stems.sampleRate,
    status: "stopped",
    syncMode: "global-bpm",
    loop: false,
    playbackMode: "soundtouch",
    keyShiftSemitones: 0,
    followsGlobalKey: true,
    stemMetadata: {
      sourceGroupId,
      stemType: stem.stemType,
      sourceFileName,
    },
  }));
}
