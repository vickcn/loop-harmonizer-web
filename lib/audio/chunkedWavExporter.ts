import { getStemAudibility } from "../band/songModel.ts";
import type { StemChannel } from "../band/bandTypes.ts";
import type { SeparatedStemSet } from "../separation/stemTypes.ts";
import {
  DEMUCS_SAMPLE_RATE,
  DEMUCS_STRIDE_SAMPLES,
  type SeparationChunkRecord,
  computeTotalChunks,
  getChunkSampleBounds,
  getChunkRecord,
  unpackBufferToChunkStems,
  validateChunkRecordIntegrity,
} from "../storage/separationChunkStore.ts";

export type WavExportFormat = "wav-float32" | "wav-pcm16";
export type WavStemExportRole =
  | "vocals"
  | "drums"
  | "bass"
  | "other"
  | "instrumental"
  | "custom_mix";

export interface CustomMixExportConfig {
  masterVolume: number;
  songMuted?: boolean;
  stemChannels: Array<Pick<StemChannel, "id" | "stemType" | "volume" | "muted" | "solo">>;
  appliesEffectsNote: string;
}

export interface WavByteSource {
  readonly totalBytes: number;
  readonly headerBytes: number;
  readonly totalSamples: number;
  readonly sampleRate: number;
  readonly channelCount: 2;
  readonly format: WavExportFormat;
  readonly role: WavStemExportRole;
  readSlice(startByte: number, endByte: number, signal?: AbortSignal): Promise<Uint8Array>;
}

export interface ParsedWavHeader {
  audioFormat: number;
  pcmFormat: WavExportFormat;
  channelCount: number;
  sampleRate: number;
  bitsPerSample: number;
  blockAlign: number;
  dataOffset: number;
  dataByteLength: number;
  totalSamples: number;
}

export const WAV_HEADER_SIZE_BYTES = 44;

export function getWavBytesPerFrame(format: WavExportFormat, channelCount = 2): number {
  const bytesPerSample = format === "wav-float32" ? 4 : 2;
  return bytesPerSample * channelCount;
}

export function computeWavTotalBytes(
  totalSamples: number,
  format: WavExportFormat,
  channelCount = 2,
): number {
  const safeFrames = Math.max(0, Math.floor(totalSamples));
  return WAV_HEADER_SIZE_BYTES + safeFrames * getWavBytesPerFrame(format, channelCount);
}

/** 建立 44-byte 標準立體聲 RIFF/WAVE Header（支援 PCM16 與 IEEE Float32）。 */
export function buildStereoWavHeader(params: {
  totalSamples: number;
  sampleRate: number;
  format: WavExportFormat;
}): Uint8Array {
  const frames = Math.max(0, Math.floor(params.totalSamples));
  const sampleRate = Math.max(8000, Math.floor(params.sampleRate || DEMUCS_SAMPLE_RATE));
  const channels = 2;
  const bitsPerSample = params.format === "wav-float32" ? 32 : 16;
  const audioFormat = params.format === "wav-float32" ? 3 : 1;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataBytes = frames * blockAlign;

  const buffer = new ArrayBuffer(WAV_HEADER_SIZE_BYTES);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, audioFormat, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);

  return new Uint8Array(buffer);
}

/** 嚴格解析 WAV Header（能正確跳過 fact/LIST/JUNK 等附加 subchunk）。 */
export function parseWavHeader(input: ArrayBuffer | Uint8Array): ParsedWavHeader {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < WAV_HEADER_SIZE_BYTES) {
    throw new Error("WAV 檔案長度過短，標頭損毀。");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readTag = (offset: number) =>
    String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );

  if (readTag(0) !== "RIFF" || readTag(8) !== "WAVE") {
    throw new Error("檔案並非有效的 RIFF/WAVE 格式。");
  }

  let offset = 12;
  let audioFormat: number | null = null;
  let channelCount: number | null = null;
  let sampleRate: number | null = null;
  let bitsPerSample: number | null = null;
  let blockAlign: number | null = null;
  let dataOffset: number | null = null;
  let dataByteLength: number | null = null;

  while (offset + 8 <= bytes.byteLength) {
    const chunkId = readTag(offset);
    const chunkSize = view.getUint32(offset + 4, true);
    const bodyOffset = offset + 8;

    if (chunkId === "fmt ") {
      if (bodyOffset + 16 > bytes.byteLength) {
        throw new Error("WAV fmt subchunk 不完整。");
      }
      audioFormat = view.getUint16(bodyOffset, true);
      channelCount = view.getUint16(bodyOffset + 2, true);
      sampleRate = view.getUint32(bodyOffset + 4, true);
      blockAlign = view.getUint16(bodyOffset + 12, true);
      bitsPerSample = view.getUint16(bodyOffset + 14, true);
    } else if (chunkId === "data") {
      dataOffset = bodyOffset;
      dataByteLength = Math.min(chunkSize, Math.max(0, bytes.byteLength - bodyOffset));
      break;
    }

    const paddedSize = chunkSize + (chunkSize % 2);
    offset = bodyOffset + paddedSize;
  }

  if (
    audioFormat === null ||
    channelCount === null ||
    sampleRate === null ||
    bitsPerSample === null ||
    blockAlign === null ||
    dataOffset === null ||
    dataByteLength === null
  ) {
    throw new Error("WAV 缺少必要 fmt 或 data 區段。");
  }

  if (channelCount !== 2) {
    throw new Error(`目前僅支援立體聲（2 聲道）分軌 WAV，收到 ${channelCount} 聲道。`);
  }

  let pcmFormat: WavExportFormat;
  if (audioFormat === 3 && bitsPerSample === 32) {
    pcmFormat = "wav-float32";
  } else if (audioFormat === 1 && bitsPerSample === 16) {
    pcmFormat = "wav-pcm16";
  } else {
    throw new Error(
      `不支援的 WAV 編碼格式（audioFormat=${audioFormat}, bitsPerSample=${bitsPerSample}）。`,
    );
  }

  const expectedAlign = getWavBytesPerFrame(pcmFormat, channelCount);
  if (blockAlign !== expectedAlign) {
    throw new Error(`WAV blockAlign 不符（預期 ${expectedAlign}，實際 ${blockAlign}）。`);
  }

  const totalSamples = Math.floor(dataByteLength / expectedAlign);
  return {
    audioFormat,
    pcmFormat,
    channelCount,
    sampleRate,
    bitsPerSample,
    blockAlign,
    dataOffset,
    dataByteLength,
    totalSamples,
  };
}

/** 驗證導出前的所有分段 Chunk 無缺口、無重複且 Checksum 完整。 */
export async function validateChunksForExport(params: {
  taskId: string;
  totalSamples: number;
  totalChunks?: number;
  strideSamples?: number;
  loadChunk?: (taskId: string, chunkIndex: number) => Promise<SeparationChunkRecord | null>;
}): Promise<{ totalChunks: number; totalSamples: number; totalChunkBytes: number }> {
  const strideSamples = params.strideSamples ?? DEMUCS_STRIDE_SAMPLES;
  const totalSamples = Math.max(0, Math.floor(params.totalSamples));
  const totalChunks = params.totalChunks ?? computeTotalChunks(totalSamples, strideSamples);
  const loadChunkFn = params.loadChunk ?? getChunkRecord;

  if (totalSamples <= 0 || totalChunks <= 0) {
    throw new Error("歌曲有效樣本長度為 0，無法輸出分軌 WAV。");
  }

  let expectedStart = 0;
  let totalChunkBytes = 0;

  for (let i = 0; i < totalChunks; i += 1) {
    const chunk = await loadChunkFn(params.taskId, i);
    if (!chunk) {
      throw new Error(`找不到第 ${i + 1}/${totalChunks} 段分離 Chunk，無法輸出完整 WAV。`);
    }
    const expectedBounds = getChunkSampleBounds(i, totalSamples, strideSamples);
    if (
      chunk.chunkIndex !== i ||
      chunk.startSample !== expectedStart ||
      chunk.startSample !== expectedBounds.startSample ||
      chunk.endSample !== expectedBounds.endSample
    ) {
      throw new Error(
        `第 ${i} 段分離 Chunk 樣本區間不連續（預期 [${expectedBounds.startSample}, ${expectedBounds.endSample})，實際 [${chunk.startSample}, ${chunk.endSample})）。`,
      );
    }
    const check = validateChunkRecordIntegrity(chunk);
    if (!check.valid) {
      throw new Error(check.reason ?? `第 ${i} 段分離 Chunk 完整性驗證失敗。`);
    }
    expectedStart = chunk.endSample;
    totalChunkBytes += chunk.sizeBytes;
  }

  if (expectedStart !== totalSamples) {
    throw new Error(
      `分離 Chunk 涵蓋樣本總數不一致（預期 ${totalSamples}，實際 ${expectedStart}）。`,
    );
  }

  return { totalChunks, totalSamples, totalChunkBytes };
}

function writeStereoSampleToDataView(
  view: DataView,
  byteOffset: number,
  leftSample: number,
  rightSample: number,
  format: WavExportFormat,
): void {
  const safeLeft = Number.isFinite(leftSample) ? leftSample : 0;
  const safeRight = Number.isFinite(rightSample) ? rightSample : 0;

  if (format === "wav-float32") {
    view.setFloat32(byteOffset, safeLeft, true);
    view.setFloat32(byteOffset + 4, safeRight, true);
    return;
  }

  // PCM16 必須執行 [-1, 1] 飽和限制並說明量化差異
  const clampL = Math.max(-1, Math.min(1, safeLeft));
  const clampR = Math.max(-1, Math.min(1, safeRight));
  view.setInt16(
    byteOffset,
    clampL < 0 ? Math.round(clampL * 32768) : Math.round(clampL * 32767),
    true,
  );
  view.setInt16(
    byteOffset + 2,
    clampR < 0 ? Math.round(clampR * 32768) : Math.round(clampR * 32767),
    true,
  );
}

function readRoleSamplePair(
  stems: ReturnType<typeof unpackBufferToChunkStems>,
  role: WavStemExportRole,
  localIndex: number,
  stemLayout: "four_stem" | "two_stem_direct",
  mixWeights?: {
    masterVolume: number;
    vocals: number;
    drums: number;
    bass: number;
    other: number;
    instrumental: number;
  },
): [number, number] {
  if (role === "vocals") {
    return [stems.vocals.left[localIndex] ?? 0, stems.vocals.right[localIndex] ?? 0];
  }
  if (role === "drums") {
    return [stems.drums.left[localIndex] ?? 0, stems.drums.right[localIndex] ?? 0];
  }
  if (role === "bass") {
    return [stems.bass.left[localIndex] ?? 0, stems.bass.right[localIndex] ?? 0];
  }
  if (role === "other") {
    return [stems.other.left[localIndex] ?? 0, stems.other.right[localIndex] ?? 0];
  }
  if (role === "instrumental") {
    if (stemLayout === "two_stem_direct") {
      // two_stem_direct 格式把伴奏直接存於 slot 1 (drums 欄位位置)
      return [stems.drums.left[localIndex] ?? 0, stems.drums.right[localIndex] ?? 0];
    }
    return [
      (stems.drums.left[localIndex] ?? 0) +
        (stems.bass.left[localIndex] ?? 0) +
        (stems.other.left[localIndex] ?? 0),
      (stems.drums.right[localIndex] ?? 0) +
        (stems.bass.right[localIndex] ?? 0) +
        (stems.other.right[localIndex] ?? 0),
    ];
  }

  // custom_mix
  const w = mixWeights ?? {
    masterVolume: 1,
    vocals: 1,
    drums: 1,
    bass: 1,
    other: 1,
    instrumental: 1,
  };
  if (w.masterVolume <= 0) return [0, 0];
  if (stemLayout === "two_stem_direct") {
    const l =
      (stems.vocals.left[localIndex] ?? 0) * w.vocals +
      (stems.drums.left[localIndex] ?? 0) * w.instrumental;
    const r =
      (stems.vocals.right[localIndex] ?? 0) * w.vocals +
      (stems.drums.right[localIndex] ?? 0) * w.instrumental;
    return [l * w.masterVolume, r * w.masterVolume];
  }

  const instFallback = w.instrumental;
  const dGain = w.drums > 0 || w.bass > 0 || w.other > 0 ? w.drums : instFallback;
  const bGain = w.drums > 0 || w.bass > 0 || w.other > 0 ? w.bass : instFallback;
  const oGain = w.drums > 0 || w.bass > 0 || w.other > 0 ? w.other : instFallback;

  const l =
    (stems.vocals.left[localIndex] ?? 0) * w.vocals +
    (stems.drums.left[localIndex] ?? 0) * dGain +
    (stems.bass.left[localIndex] ?? 0) * bGain +
    (stems.other.left[localIndex] ?? 0) * oGain;
  const r =
    (stems.vocals.right[localIndex] ?? 0) * w.vocals +
    (stems.drums.right[localIndex] ?? 0) * dGain +
    (stems.bass.right[localIndex] ?? 0) * bGain +
    (stems.other.right[localIndex] ?? 0) * oGain;
  return [l * w.masterVolume, r * w.masterVolume];
}

function buildMixWeights(config?: CustomMixExportConfig) {
  if (!config) {
    return {
      masterVolume: 1,
      vocals: 1,
      drums: 1,
      bass: 1,
      other: 1,
      instrumental: 1,
    };
  }
  const masterVolume = config.songMuted
    ? 0
    : Math.max(0, Math.min(1, Number.isFinite(config.masterVolume) ? config.masterVolume : 1));
  const audibility = getStemAudibility(config.stemChannels);
  const gainFor = (stemType: string): number => {
    const ch = config.stemChannels.find((item) => item.stemType === stemType);
    if (!ch) return 0;
    if (!audibility[ch.id]) return 0;
    return Math.max(0, Math.min(1, Number.isFinite(ch.volume) ? ch.volume : 1));
  };
  return {
    masterVolume,
    vocals: gainFor("vocals"),
    drums: gainFor("drums"),
    bass: gainFor("bass"),
    other: gainFor("other"),
    instrumental: gainFor("instrumental"),
  };
}

/**
 * 低記憶體分段 WAV 位元流來源：
 * 任意 [startByte, endByte) 切片只載入與該位元範圍相交的單顆 Chunk（用完即釋放參照），
 * 絕不在記憶體建立 4 條全曲 Float32Array 或整首歌曲 AudioBuffer。
 */
export function createChunkedStemWavSource(params: {
  taskId: string;
  role: WavStemExportRole;
  totalSamples: number;
  sampleRate?: number;
  strideSamples?: number;
  format: WavExportFormat;
  stemLayout?: "four_stem" | "two_stem_direct";
  mixConfig?: CustomMixExportConfig;
  loadChunk?: (taskId: string, chunkIndex: number) => Promise<SeparationChunkRecord | null>;
}): WavByteSource {
  const sampleRate = params.sampleRate ?? DEMUCS_SAMPLE_RATE;
  const strideSamples = params.strideSamples ?? DEMUCS_STRIDE_SAMPLES;
  const totalSamples = Math.max(0, Math.floor(params.totalSamples));
  const totalChunks = computeTotalChunks(totalSamples, strideSamples);
  const bytesPerFrame = getWavBytesPerFrame(params.format, 2);
  const totalBytes = computeWavTotalBytes(totalSamples, params.format, 2);
  const header = buildStereoWavHeader({
    totalSamples,
    sampleRate,
    format: params.format,
  });
  const loadChunkFn = params.loadChunk ?? getChunkRecord;
  const stemLayout = params.stemLayout ?? "four_stem";
  const mixWeights =
    params.role === "custom_mix" ? buildMixWeights(params.mixConfig) : undefined;

  return {
    totalBytes,
    headerBytes: WAV_HEADER_SIZE_BYTES,
    totalSamples,
    sampleRate,
    channelCount: 2,
    format: params.format,
    role: params.role,
    async readSlice(startByte: number, endByte: number, signal?: AbortSignal): Promise<Uint8Array> {
      const clampedStart = Math.max(0, Math.min(totalBytes, Math.floor(startByte)));
      const clampedEnd = Math.max(clampedStart, Math.min(totalBytes, Math.floor(endByte)));
      const sliceLen = clampedEnd - clampedStart;
      const out = new Uint8Array(sliceLen);
      if (sliceLen === 0) return out;

      let writeCursor = 0;

      // 1) 複製 WAV Header 區段
      if (clampedStart < WAV_HEADER_SIZE_BYTES) {
        const headerEnd = Math.min(WAV_HEADER_SIZE_BYTES, clampedEnd);
        out.set(header.subarray(clampedStart, headerEnd), 0);
        writeCursor += headerEnd - clampedStart;
      }

      if (clampedEnd <= WAV_HEADER_SIZE_BYTES) {
        return out;
      }

      // 2) 計算涵蓋的音訊位元組範圍並逐塊寫入（僅在迴圈內暫時讀取單顆 Chunk）
      const audioByteStart = Math.max(0, clampedStart - WAV_HEADER_SIZE_BYTES);
      const audioByteEnd = clampedEnd - WAV_HEADER_SIZE_BYTES;
      const firstSample = Math.floor(audioByteStart / bytesPerFrame);
      const lastSampleInclusive = Math.min(
        totalSamples - 1,
        Math.floor((audioByteEnd - 1) / bytesPerFrame),
      );
      if (lastSampleInclusive < firstSample) {
        return out;
      }

      const firstChunkIdx = Math.floor(firstSample / strideSamples);
      const lastChunkIdx = Math.min(
        totalChunks - 1,
        Math.floor(lastSampleInclusive / strideSamples),
      );

      const frameScratch = new ArrayBuffer(bytesPerFrame);
      const frameScratchView = new DataView(frameScratch);
      const frameScratchBytes = new Uint8Array(frameScratch);

      for (let chunkIdx = firstChunkIdx; chunkIdx <= lastChunkIdx; chunkIdx += 1) {
        if (signal?.aborted) {
          throw new DOMException("已中止分段 WAV 讀取。", "AbortError");
        }
        const chunk = await loadChunkFn(params.taskId, chunkIdx);
        if (!chunk) {
          throw new Error(`讀取分段 WAV 時找不到第 ${chunkIdx} 段 Chunk。`);
        }
        const chunkFrameCount = chunk.endSample - chunk.startSample;
        const unpacked = unpackBufferToChunkStems(chunk.payload, chunkFrameCount);

        const overlapStartSample = Math.max(firstSample, chunk.startSample);
        const overlapEndSample = Math.min(lastSampleInclusive + 1, chunk.endSample);

        for (let sampleIdx = overlapStartSample; sampleIdx < overlapEndSample; sampleIdx += 1) {
          const localIdx = sampleIdx - chunk.startSample;
          const [leftVal, rightVal] = readRoleSamplePair(
            unpacked,
            params.role,
            localIdx,
            stemLayout,
            mixWeights,
          );
          const sampleAbsByteStart = WAV_HEADER_SIZE_BYTES + sampleIdx * bytesPerFrame;
          const sampleAbsByteEnd = sampleAbsByteStart + bytesPerFrame;

          if (sampleAbsByteStart >= clampedStart && sampleAbsByteEnd <= clampedEnd) {
            const outView = new DataView(out.buffer, out.byteOffset + writeCursor, bytesPerFrame);
            writeStereoSampleToDataView(outView, 0, leftVal, rightVal, params.format);
            writeCursor += bytesPerFrame;
          } else {
            // 處理恰好落在 sample 內部切分的切片邊界（確保對任何 byte offset 均嚴格精確）
            writeStereoSampleToDataView(frameScratchView, 0, leftVal, rightVal, params.format);
            const subFrom = Math.max(0, clampedStart - sampleAbsByteStart);
            const subTo = Math.min(bytesPerFrame, clampedEnd - sampleAbsByteStart);
            for (let b = subFrom; b < subTo; b += 1) {
              out[writeCursor++] = frameScratchBytes[b];
            }
          }
        }
      }

      return out;
    },
  };
}

/** 由既有記憶體中 SeparatedStemSet 建立相容 WavByteSource（支援舊版 fast-cache 歌曲）。 */
export function createInMemoryStemWavSource(params: {
  stems: SeparatedStemSet;
  role: WavStemExportRole;
  format: WavExportFormat;
  mixConfig?: CustomMixExportConfig;
}): WavByteSource {
  const firstTrack = params.stems.tracks[0];
  const totalSamples = firstTrack?.left.length ?? 0;
  const sampleRate = params.stems.sampleRate || DEMUCS_SAMPLE_RATE;
  const bytesPerFrame = getWavBytesPerFrame(params.format, 2);
  const totalBytes = computeWavTotalBytes(totalSamples, params.format, 2);
  const header = buildStereoWavHeader({
    totalSamples,
    sampleRate,
    format: params.format,
  });
  const mixWeights =
    params.role === "custom_mix" ? buildMixWeights(params.mixConfig) : undefined;

  const trackMap = new Map(params.stems.tracks.map((t) => [t.stemType, t]));

  const samplePairAt = (sampleIdx: number): [number, number] => {
    if (params.role === "custom_mix") {
      const w = mixWeights!;
      if (w.masterVolume <= 0) return [0, 0];
      let l = 0;
      let r = 0;
      for (const track of params.stems.tracks) {
        const gain =
          track.stemType === "vocals"
            ? w.vocals
            : track.stemType === "drums"
              ? w.drums
              : track.stemType === "bass"
                ? w.bass
                : track.stemType === "other"
                  ? w.other
                  : w.instrumental;
        l += (track.left[sampleIdx] ?? 0) * gain;
        r += (track.right[sampleIdx] ?? 0) * gain;
      }
      return [l * w.masterVolume, r * w.masterVolume];
    }
    const direct = trackMap.get(params.role);
    if (direct) {
      return [direct.left[sampleIdx] ?? 0, direct.right[sampleIdx] ?? 0];
    }
    if (params.role === "instrumental") {
      const d = trackMap.get("drums");
      const b = trackMap.get("bass");
      const o = trackMap.get("other");
      return [
        (d?.left[sampleIdx] ?? 0) + (b?.left[sampleIdx] ?? 0) + (o?.left[sampleIdx] ?? 0),
        (d?.right[sampleIdx] ?? 0) + (b?.right[sampleIdx] ?? 0) + (o?.right[sampleIdx] ?? 0),
      ];
    }
    return [0, 0];
  };

  return {
    totalBytes,
    headerBytes: WAV_HEADER_SIZE_BYTES,
    totalSamples,
    sampleRate,
    channelCount: 2,
    format: params.format,
    role: params.role,
    async readSlice(startByte: number, endByte: number, signal?: AbortSignal): Promise<Uint8Array> {
      if (signal?.aborted) {
        throw new DOMException("已中止 WAV 讀取。", "AbortError");
      }
      const clampedStart = Math.max(0, Math.min(totalBytes, Math.floor(startByte)));
      const clampedEnd = Math.max(clampedStart, Math.min(totalBytes, Math.floor(endByte)));
      const out = new Uint8Array(clampedEnd - clampedStart);
      if (out.byteLength === 0) return out;

      let cursor = 0;
      if (clampedStart < WAV_HEADER_SIZE_BYTES) {
        const hEnd = Math.min(WAV_HEADER_SIZE_BYTES, clampedEnd);
        out.set(header.subarray(clampedStart, hEnd), 0);
        cursor += hEnd - clampedStart;
      }
      if (clampedEnd <= WAV_HEADER_SIZE_BYTES) return out;

      const audioStart = Math.max(0, clampedStart - WAV_HEADER_SIZE_BYTES);
      const audioEnd = clampedEnd - WAV_HEADER_SIZE_BYTES;
      const firstSample = Math.floor(audioStart / bytesPerFrame);
      const lastSample = Math.min(totalSamples - 1, Math.floor((audioEnd - 1) / bytesPerFrame));
      const scratch = new ArrayBuffer(bytesPerFrame);
      const scratchView = new DataView(scratch);
      const scratchBytes = new Uint8Array(scratch);

      for (let s = firstSample; s <= lastSample; s += 1) {
        const [l, r] = samplePairAt(s);
        const absStart = WAV_HEADER_SIZE_BYTES + s * bytesPerFrame;
        const absEnd = absStart + bytesPerFrame;
        if (absStart >= clampedStart && absEnd <= clampedEnd) {
          const v = new DataView(out.buffer, out.byteOffset + cursor, bytesPerFrame);
          writeStereoSampleToDataView(v, 0, l, r, params.format);
          cursor += bytesPerFrame;
        } else {
          writeStereoSampleToDataView(scratchView, 0, l, r, params.format);
          const subFrom = Math.max(0, clampedStart - absStart);
          const subTo = Math.min(bytesPerFrame, clampedEnd - absStart);
          for (let b = subFrom; b < subTo; b += 1) {
            out[cursor++] = scratchBytes[b];
          }
        }
      }
      return out;
    },
  };
}

// ── 串流 SHA-256（每次僅處理 1 MiB slice，絕不將完整大檔塞進單一 ArrayBuffer） ──

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class StreamingSha256 {
  private readonly h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly block = new Uint8Array(64);
  private readonly w = new Uint32Array(64);
  private blockLen = 0;
  private totalBytes = 0;

  update(data: Uint8Array): void {
    let offset = 0;
    this.totalBytes += data.byteLength;
    if (this.blockLen > 0) {
      const take = Math.min(64 - this.blockLen, data.byteLength);
      this.block.set(data.subarray(0, take), this.blockLen);
      this.blockLen += take;
      offset += take;
      if (this.blockLen === 64) {
        this.compress(this.block, 0);
        this.blockLen = 0;
      }
    }
    while (offset + 64 <= data.byteLength) {
      this.compress(data, offset);
      offset += 64;
    }
    if (offset < data.byteLength) {
      const rest = data.subarray(offset);
      this.block.set(rest, 0);
      this.blockLen = rest.byteLength;
    }
  }

  digestHex(): string {
    const bitLen = this.totalBytes * 8;
    const padLen = this.blockLen < 56 ? 56 - this.blockLen : 120 - this.blockLen;
    const padding = new Uint8Array(padLen + 8);
    padding[0] = 0x80;
    const view = new DataView(padding.buffer);
    const high = Math.floor(bitLen / 0x100000000);
    const low = bitLen >>> 0;
    view.setUint32(padLen, high, false);
    view.setUint32(padLen + 4, low, false);
    this.update(padding);

    let hex = "";
    for (let i = 0; i < 8; i += 1) {
      hex += (this.h[i] >>> 0).toString(16).padStart(8, "0");
    }
    return hex;
  }

  private compress(buf: Uint8Array, offset: number): void {
    const w = this.w;
    for (let i = 0; i < 16; i += 1) {
      const idx = offset + i * 4;
      w[i] =
        ((buf[idx] << 24) |
          (buf[idx + 1] << 16) |
          (buf[idx + 2] << 8) |
          buf[idx + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 =
        ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^
        ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^
        (w[i - 15] >>> 3);
      const s1 =
        ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^
        ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^
        (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, hh] = this.h;
    for (let i = 0; i < 64; i += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    this.h[0] = (this.h[0] + a) >>> 0;
    this.h[1] = (this.h[1] + b) >>> 0;
    this.h[2] = (this.h[2] + c) >>> 0;
    this.h[3] = (this.h[3] + d) >>> 0;
    this.h[4] = (this.h[4] + e) >>> 0;
    this.h[5] = (this.h[5] + f) >>> 0;
    this.h[6] = (this.h[6] + g) >>> 0;
    this.h[7] = (this.h[7] + hh) >>> 0;
  }
}

export function computeSha256HexSync(data: Uint8Array): string {
  const hasher = new StreamingSha256();
  hasher.update(data);
  return hasher.digestHex();
}

export async function computeWavSourceSha256(
  source: WavByteSource,
  signal?: AbortSignal,
  sliceBytes = 1024 * 1024,
): Promise<string> {
  const hasher = new StreamingSha256();
  for (let offset = 0; offset < source.totalBytes; offset += sliceBytes) {
    if (signal?.aborted) {
      throw new DOMException("已取消雜湊計算。", "AbortError");
    }
    const end = Math.min(source.totalBytes, offset + sliceBytes);
    const slice = await source.readSlice(offset, end, signal);
    hasher.update(slice);
  }
  return hasher.digestHex();
}

/** 從已解析的立體聲 WAV 二進位緩衝區讀取指定樣本區間 [startSample, endSample) 轉成 Float32Array[L, R]。 */
export function decodeWavSampleRange(
  buffer: ArrayBuffer | Uint8Array,
  header: ParsedWavHeader,
  startSample: number,
  endSample: number,
): { left: Float32Array; right: Float32Array } {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const clampedStart = Math.max(0, Math.min(header.totalSamples, startSample));
  const clampedEnd = Math.max(clampedStart, Math.min(header.totalSamples, endSample));
  const count = clampedEnd - clampedStart;
  const left = new Float32Array(count);
  const right = new Float32Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (header.pcmFormat === "wav-float32") {
    for (let i = 0; i < count; i += 1) {
      const bytePos = header.dataOffset + (clampedStart + i) * 8;
      left[i] = view.getFloat32(bytePos, true);
      right[i] = view.getFloat32(bytePos + 4, true);
    }
  } else {
    for (let i = 0; i < count; i += 1) {
      const bytePos = header.dataOffset + (clampedStart + i) * 4;
      left[i] = view.getInt16(bytePos, true) / 32768;
      right[i] = view.getInt16(bytePos + 2, true) / 32768;
    }
  }

  return { left, right };
}
