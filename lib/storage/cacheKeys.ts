export const DEMUCS_MODEL_ID = "demucs-htdemucs";
export const DEMUCS_MODEL_VERSION = "browser-demucs-v1";
export const SEPARATION_PROCESSING_VERSION = "loop-harmonizer-stems-v2";

export function createSeparationCacheKey(input: {
  sourceAudioHash: string;
  modelVersion: string;
  separationMode: string;
  processingVersion?: string;
}): string {
  return [
    input.sourceAudioHash,
    input.modelVersion,
    input.separationMode,
    input.processingVersion ?? SEPARATION_PROCESSING_VERSION,
  ].join(":");
}
