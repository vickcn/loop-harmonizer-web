import type { StereoPcm } from "./stemTypes";

export function createAudioBufferFromStem(
  context: Pick<AudioContext, "createBuffer">,
  stem: StereoPcm,
  sampleRate: number,
): AudioBuffer {
  const frames = Math.min(stem.left.length, stem.right.length);
  const buffer = context.createBuffer(2, frames, sampleRate);
  buffer.getChannelData(0).set(stem.left.subarray(0, frames));
  buffer.getChannelData(1).set(stem.right.subarray(0, frames));
  return buffer;
}
