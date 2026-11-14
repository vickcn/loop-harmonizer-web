import type {
  FourStemPcm,
  StemType,
  StereoPcm,
  TwoStemPcm,
} from "../separation/stemTypes.ts";
import { idbGet, idbGetAll, idbRequestPromise, withIdbTransaction } from "./indexedDb.ts";

export const DEMUCS_SAMPLE_RATE = 44100;
export const DEMUCS_TRAINING_SAMPLES = 343980;
export const DEMUCS_SEGMENT_OVERLAP = 0.25;
export const DEMUCS_STRIDE_SAMPLES = Math.floor(
  DEMUCS_TRAINING_SAMPLES * (1 - DEMUCS_SEGMENT_OVERLAP),
); // 257985
export const DEMUCS_OVERLAP_SAMPLES = DEMUCS_TRAINING_SAMPLES - DEMUCS_STRIDE_SAMPLES; // 85995
export const DEMUCS_OVERLAP_CARRY_CHANNELS = 4 * 2 + 1; // 4 stems * (L, R) + 1 rollingWeights
export const DEMUCS_OVERLAP_CARRY_BYTES =
  DEMUCS_OVERLAP_CARRY_CHANNELS * DEMUCS_OVERLAP_SAMPLES * Float32Array.BYTES_PER_ELEMENT;

export const DEMUCS_CHUNK_STEM_ORDER: readonly (keyof FourStemPcm)[] = [
  "vocals",
  "drums",
  "bass",
  "other",
];

export const MAX_VALID_STEM_ABS_SAMPLE = 4.0;

export interface SeparatedChunk {
  taskId: string;
  chunkIndex: number;
  startSample: number;
  endSample: number;
  sampleRate: number;
  stems: FourStemPcm;
}

export interface SeparationChunkRecord {
  /** IndexedDB keyPath: `${taskId}:chunk:${chunkIndex}` */
  key: string;
  taskId: string;
  chunkIndex: number;
  startSample: number;
  endSample: number;
  modelVersion: string;
  processingVersion: string;
  separationMode: "four_stem";
  sampleRate: number;
  stemCount: 4;
  /** 連續 Float32 packing，順序固定為 [vocals(L,R), drums(L,R), bass(L,R), other(L,R)] */
  payload: ArrayBuffer;
  checksum: string;
  sizeBytes: number;
  createdAt: number;
}

export function createChunkKey(taskId: string, chunkIndex: number): string {
  return `${taskId}:chunk:${chunkIndex}`;
}

export function computeTotalChunks(
  totalSamples: number,
  strideSamples = DEMUCS_STRIDE_SAMPLES,
): number {
  if (!Number.isFinite(totalSamples) || totalSamples <= 0) return 0;
  if (!Number.isFinite(strideSamples) || strideSamples <= 0) {
    throw new Error(`無效的 strideSamples：${strideSamples}`);
  }
  return Math.max(1, Math.ceil(totalSamples / strideSamples));
}

export function getChunkSampleBounds(
  chunkIndex: number,
  totalSamples: number,
  strideSamples = DEMUCS_STRIDE_SAMPLES,
): { startSample: number; endSample: number; frameCount: number } {
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
    throw new Error(`無效的 chunkIndex：${chunkIndex}`);
  }
  const startSample = Math.min(chunkIndex * strideSamples, totalSamples);
  const endSample = Math.min(startSample + strideSamples, totalSamples);
  return {
    startSample,
    endSample,
    frameCount: Math.max(0, endSample - startSample),
  };
}

export function expectedChunkPayloadBytes(frameCount: number, stemCount = 4): number {
  return stemCount * 2 * frameCount * Float32Array.BYTES_PER_ELEMENT;
}

/**
 * 同步計算 64-bit FNV-1a 雜湊值（十六進位 16 字元），用於驗證 Chunk 二進位完整性。
 * 全程於原地逐位元組掃描，不配置額外緩衝區。
 */
export function computeBufferChecksum(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hash = BigInt("0xcbf29ce484222325");
  const prime = BigInt("0x100000001b3");
  const mask = BigInt("0xffffffffffffffff");
  for (let i = 0; i < bytes.length; i++) {
    hash ^= BigInt(bytes[i]);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

export function validateChunkPayloadInPlace(
  payload: ArrayBuffer,
  frameCount: number,
  stemCount = 4,
): { valid: boolean; reason?: string } {
  const expectedBytes = expectedChunkPayloadBytes(frameCount, stemCount);
  if (!(payload instanceof ArrayBuffer) || payload.byteLength !== expectedBytes) {
    return {
      valid: false,
      reason: `Chunk 位元組長度不符（預期 ${expectedBytes}，實際 ${payload?.byteLength ?? 0}）`,
    };
  }
  if (frameCount <= 0) {
    return { valid: false, reason: `無效的 Chunk 樣本數：${frameCount}` };
  }
  const view = new Float32Array(payload);
  for (let i = 0; i < view.length; i++) {
    const v = view[i];
    if (!Number.isFinite(v)) {
      return { valid: false, reason: `Chunk 包含非有限數值（NaN/Infinity）於索引 ${i}` };
    }
    if (Math.abs(v) > MAX_VALID_STEM_ABS_SAMPLE) {
      return {
        valid: false,
        reason: `Chunk 振幅異常超限（|${v}| > ${MAX_VALID_STEM_ABS_SAMPLE}）於索引 ${i}`,
      };
    }
  }
  return { valid: true };
}

export function validateChunkRecordIntegrity(
  record: SeparationChunkRecord,
): { valid: boolean; reason?: string } {
  if (!record || typeof record !== "object") {
    return { valid: false, reason: "Chunk 紀錄為空" };
  }
  if (record.separationMode !== "four_stem" || record.stemCount !== 4) {
    return { valid: false, reason: "Chunk 格式必須為 4 軌標準儲存" };
  }
  const frameCount = record.endSample - record.startSample;
  if (frameCount <= 0) {
    return {
      valid: false,
      reason: `Chunk 區間無效：[${record.startSample}, ${record.endSample})`,
    };
  }
  if (record.sizeBytes !== record.payload?.byteLength) {
    return { valid: false, reason: "Chunk sizeBytes 與 payload 長度不一致" };
  }
  const payloadCheck = validateChunkPayloadInPlace(record.payload, frameCount, 4);
  if (!payloadCheck.valid) return payloadCheck;

  const actualChecksum = computeBufferChecksum(record.payload);
  if (actualChecksum !== record.checksum) {
    return {
      valid: false,
      reason: `Chunk ${record.chunkIndex} checksum 驗證失敗（預期 ${record.checksum}，實際 ${actualChecksum}）`,
    };
  }
  return { valid: true };
}

export function packChunkStemsToBuffer(stems: FourStemPcm, frameCount: number): ArrayBuffer {
  const totalBytes = expectedChunkPayloadBytes(frameCount, 4);
  const buffer = new ArrayBuffer(totalBytes);
  const floatView = new Float32Array(buffer);
  for (let s = 0; s < DEMUCS_CHUNK_STEM_ORDER.length; s++) {
    const stemKey = DEMUCS_CHUNK_STEM_ORDER[s];
    const pcm = stems[stemKey];
    if (!pcm || pcm.left.length < frameCount || pcm.right.length < frameCount) {
      throw new Error(`Chunk 軌 ${stemKey} 長度不足 ${frameCount}`);
    }
    const baseOffset = s * 2 * frameCount;
    floatView.set(pcm.left.subarray(0, frameCount), baseOffset);
    floatView.set(pcm.right.subarray(0, frameCount), baseOffset + frameCount);
  }
  return buffer;
}

/** Zero-copy view 解包 4 軌 Chunk payload（subarray 共享同一 ArrayBuffer 視圖） */
export function unpackBufferToChunkStems(
  payload: ArrayBuffer,
  frameCount: number,
): FourStemPcm {
  const expectedBytes = expectedChunkPayloadBytes(frameCount, 4);
  if (payload.byteLength !== expectedBytes) {
    throw new Error(`Chunk payload 長度不符（預期 ${expectedBytes}，實際 ${payload.byteLength}）`);
  }
  const floatView = new Float32Array(payload);
  const slicePair = (stemIdx: number): StereoPcm => {
    const base = stemIdx * 2 * frameCount;
    return {
      left: floatView.subarray(base, base + frameCount),
      right: floatView.subarray(base + frameCount, base + frameCount * 2),
    };
  };
  return {
    vocals: slicePair(0),
    drums: slicePair(1),
    bass: slicePair(2),
    other: slicePair(3),
  };
}

/** 由 4 軌 Chunk payload 即時合成 2 軌（vocals + instrumental），無須重新推論 Demucs */
export function deriveTwoStemFromChunkBuffer(
  payload: ArrayBuffer,
  frameCount: number,
): TwoStemPcm {
  const four = unpackBufferToChunkStems(payload, frameCount);
  const instLeft = new Float32Array(frameCount);
  const instRight = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    instLeft[i] = four.drums.left[i] + four.bass.left[i] + four.other.left[i];
    instRight[i] = four.drums.right[i] + four.bass.right[i] + four.other.right[i];
  }
  return {
    vocals: four.vocals,
    instrumental: { left: instLeft, right: instRight },
  };
}

export async function getChunkRecord(
  taskId: string,
  chunkIndex: number,
): Promise<SeparationChunkRecord | null> {
  return idbGet<SeparationChunkRecord>("separationChunks", createChunkKey(taskId, chunkIndex));
}

export async function getTaskChunkRecords(taskId: string): Promise<SeparationChunkRecord[]> {
  const all = await idbGetAll<SeparationChunkRecord>("separationChunks");
  return all
    .filter((rec) => rec.taskId === taskId)
    .sort((a, b) => a.chunkIndex - b.chunkIndex);
}

export async function deleteTaskChunks(taskId: string): Promise<number> {
  return withIdbTransaction("separationChunks", "readwrite", async (tx) => {
    const store = tx.objectStore("separationChunks");
    const all = (await idbRequestPromise(store.getAll())) as SeparationChunkRecord[];
    let deleted = 0;
    for (const rec of all) {
      if (rec.taskId === taskId) {
        await idbRequestPromise(store.delete(rec.key));
        deleted++;
      }
    }
    return deleted;
  });
}
