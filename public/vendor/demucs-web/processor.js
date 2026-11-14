/**
 * Demucs audio processor - Core separation logic
 */

import { CONSTANTS } from './constants.js';
import { stft, istft, reflectPad } from './fft.js';

const { SAMPLE_RATE, FFT_SIZE, HOP_SIZE, TRAINING_SAMPLES, MODEL_SPEC_BINS, MODEL_SPEC_FRAMES, SEGMENT_OVERLAP, TRACKS } = CONSTANTS;

/**
 * Convert model frequency output to complex spectrogram per track
 */
export function standaloneMask(freqOutput) {
  const numTracks = 4;
  const numChannels = 4;
  const numBins = MODEL_SPEC_BINS;
  const numFrames = MODEL_SPEC_FRAMES;
  const result = [];

  for (let t = 0; t < numTracks; t++) {
    const trackSpec = {
      leftReal: new Float32Array(numBins * numFrames),
      leftImag: new Float32Array(numBins * numFrames),
      rightReal: new Float32Array(numBins * numFrames),
      rightImag: new Float32Array(numBins * numFrames)
    };

    for (let f = 0; f < numFrames; f++) {
      for (let b = 0; b < numBins; b++) {
        const baseIdx = t * numChannels * numBins * numFrames;
        const outIdx = b * numFrames + f;
        trackSpec.leftReal[outIdx] = freqOutput[baseIdx + 0 * numBins * numFrames + b * numFrames + f];
        trackSpec.leftImag[outIdx] = freqOutput[baseIdx + 1 * numBins * numFrames + b * numFrames + f];
        trackSpec.rightReal[outIdx] = freqOutput[baseIdx + 2 * numBins * numFrames + b * numFrames + f];
        trackSpec.rightImag[outIdx] = freqOutput[baseIdx + 3 * numBins * numFrames + b * numFrames + f];
      }
    }
    result.push(trackSpec);
  }

  return result;
}

/**
 * Convert complex spectrogram back to time domain (iSTFT with proper offsets)
 */
export function standaloneIspec(trackSpec, targetLength) {
  const numBins = MODEL_SPEC_BINS;
  const numFrames = MODEL_SPEC_FRAMES;
  const hopLength = HOP_SIZE;
  const paddedBins = numBins + 1;
  const paddedFrames = numFrames + 4;

  const padChannel = (real, imag) => {
    const paddedReal = new Float32Array(paddedFrames * paddedBins);
    const paddedImag = new Float32Array(paddedFrames * paddedBins);

    for (let f = 0; f < numFrames; f++) {
      for (let b = 0; b < numBins; b++) {
        const srcIdx = b * numFrames + f;
        const dstFrame = f + 2;
        const dstIdx = dstFrame * paddedBins + b;
        paddedReal[dstIdx] = real[srcIdx];
        paddedImag[dstIdx] = imag[srcIdx];
      }
    }
    return { real: paddedReal, imag: paddedImag };
  };

  const leftPadded = padChannel(trackSpec.leftReal, trackSpec.leftImag);
  const rightPadded = padChannel(trackSpec.rightReal, trackSpec.rightImag);

  const centerPad = FFT_SIZE / 2;
  const pad = Math.floor(hopLength / 2) * 3;
  const istftLength = (paddedFrames - 1) * hopLength + FFT_SIZE;

  const leftOut = istft(leftPadded.real, leftPadded.imag, paddedFrames, paddedBins, FFT_SIZE, hopLength, istftLength);
  const rightOut = istft(rightPadded.real, rightPadded.imag, paddedFrames, paddedBins, FFT_SIZE, hopLength, istftLength);

  const totalOffset = centerPad + pad;
  const left = leftOut.subarray(totalOffset, totalOffset + targetLength);
  const right = rightOut.subarray(totalOffset, totalOffset + targetLength);

  return { left: new Float32Array(left), right: new Float32Array(right) };
}

/**
 * Prepare model input from stereo audio
 */
export function prepareModelInput(leftChannel, rightChannel) {
  const inputLength = TRAINING_SAMPLES;

  const paddedLeft = new Float32Array(inputLength);
  const paddedRight = new Float32Array(inputLength);
  const copyLen = Math.min(leftChannel.length, inputLength);
  paddedLeft.set(leftChannel.subarray(0, copyLen));
  paddedRight.set(rightChannel.subarray(0, copyLen));

  const le = Math.ceil(inputLength / HOP_SIZE);
  const pad = Math.floor(HOP_SIZE / 2) * 3;
  const padRight = pad + le * HOP_SIZE - inputLength;

  const stftInputLeft = reflectPad(paddedLeft, pad, padRight);
  const stftInputRight = reflectPad(paddedRight, pad, padRight);

  const centerPad = FFT_SIZE / 2;
  const centeredLeft = reflectPad(stftInputLeft, centerPad, centerPad);
  const centeredRight = reflectPad(stftInputRight, centerPad, centerPad);

  const stftLeft = stft(centeredLeft, FFT_SIZE, HOP_SIZE);
  const stftRight = stft(centeredRight, FFT_SIZE, HOP_SIZE);

  const numBins = MODEL_SPEC_BINS;
  const numFrames = MODEL_SPEC_FRAMES;
  const frameOffset = 2;

  const magSpec = new Float32Array(4 * numBins * numFrames);

  for (let f = 0; f < numFrames; f++) {
    const srcFrame = f + frameOffset;
    for (let b = 0; b < numBins; b++) {
      const srcIdx = srcFrame * stftLeft.numBins + b;
      magSpec[0 * numBins * numFrames + b * numFrames + f] = stftLeft.real[srcIdx];
      magSpec[1 * numBins * numFrames + b * numFrames + f] = stftLeft.imag[srcIdx];
      magSpec[2 * numBins * numFrames + b * numFrames + f] = stftRight.real[srcIdx];
      magSpec[3 * numBins * numFrames + b * numFrames + f] = stftRight.imag[srcIdx];
    }
  }

  const waveform = new Float32Array(2 * inputLength);
  waveform.set(paddedLeft, 0);
  waveform.set(paddedRight, inputLength);

  return { waveform, magSpec, numBins, numFrames, originalLength: leftChannel.length };
}

function createAbortError(message = 'Operation aborted') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) {
    throw createAbortError('音源分離已取消');
  }
}

function yieldToEventLoop() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function safeDisposeTensor(tensor) {
  try {
    if (tensor && typeof tensor.dispose === 'function') {
      tensor.dispose();
    }
  } catch {
    // ignore tensor dispose errors during cleanup
  }
}

/**
 * Main Demucs processor class
 */
export class DemucsProcessor {
  constructor(options = {}) {
    this.ort = options.ort || null;
    this.session = null;
    this.modelPath = options.modelPath || './htdemucs_embedded.onnx';
    this.sessionOptions = options.sessionOptions || {};
    this.onProgress = options.onProgress || (() => {});
    this.onLog = options.onLog || (() => {});
    this.onDownloadProgress = options.onDownloadProgress || (() => {});
  }

  async loadModel(modelPathOrBuffer, options = {}) {
    if (!this.ort) {
      throw new Error('ONNX Runtime not provided. Pass ort in constructor options.');
    }

    const signal = options?.signal;
    throwIfAborted(signal);
    this.onLog('model', 'Loading model...');

    let modelBuffer;
    if (modelPathOrBuffer instanceof ArrayBuffer) {
      modelBuffer = modelPathOrBuffer;
    } else {
      const response = await fetch(modelPathOrBuffer || this.modelPath, { signal });
      if (!response.ok) {
        throw new Error(`模型載入失敗 (${response.status})`);
      }

      // Check if we can track progress
      const contentLength = response.headers.get('Content-Length');
      if (contentLength && response.body) {
        const totalSize = parseInt(contentLength, 10);
        const reader = response.body.getReader();
        const chunks = [];
        let loadedSize = 0;

        try {
          while (true) {
            if (signal?.aborted) {
              try { await reader.cancel(); } catch {}
              chunks.length = 0;
              throw createAbortError('模型下載已取消');
            }
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              chunks.push(value);
              loadedSize += value.length;
              this.onDownloadProgress(loadedSize, totalSize);
            }
          }
        } finally {
          if (signal?.aborted) {
            chunks.length = 0;
          }
        }

        // Combine chunks into single ArrayBuffer
        const combined = new Uint8Array(loadedSize);
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.length;
        }
        chunks.length = 0;
        modelBuffer = combined.buffer;
      } else {
        // Fallback: no progress tracking
        modelBuffer = await response.arrayBuffer();
      }
    }

    throwIfAborted(signal);

    const defaultSessionOptions = {
      executionProviders: ['webgpu', 'wasm'],
      graphOptimizationLevel: 'basic'
    };

    const session = await this.ort.InferenceSession.create(modelBuffer, {
      ...defaultSessionOptions,
      ...this.sessionOptions
    });
    modelBuffer = null;

    if (signal?.aborted) {
      try {
        if (session && typeof session.release === 'function') {
          await session.release();
        }
      } catch {}
      throw createAbortError('模型初始化已取消');
    }

    this.session = session;
    this.onLog('model', 'Model loaded successfully');
    return this.session;
  }

  async disposeSession() {
    const current = this.session;
    this.session = null;
    if (current && typeof current.release === 'function') {
      try {
        await current.release();
      } catch {}
    }
  }

  async separate(leftChannel, rightChannel, options = {}) {
    if (!this.session) {
      throw new Error('Model not loaded. Call loadModel() first.');
    }

    const signal = options?.signal;
    const mode = options?.mode === 'two_stem' ? 'two_stem' : 'four_stem';
    const onChunk = typeof options?.onChunk === 'function' ? options.onChunk : null;
    const shouldPause = typeof options?.shouldPause === 'function' ? options.shouldPause : null;
    const inputOffsetSample = Math.max(0, Math.floor(options?.inputOffsetSample ?? 0));
    const totalSamples = Math.max(
      leftChannel.length + inputOffsetSample,
      Math.floor(options?.totalSamples ?? leftChannel.length + inputOffsetSample),
    );
    const startChunkIndex = Math.max(0, Math.floor(options?.startChunkIndex ?? 0));
    throwIfAborted(signal);

    const stride = Math.floor(TRAINING_SAMPLES * (1 - SEGMENT_OVERLAP));
    const overlapSamples = TRAINING_SAMPLES - stride;
    const numSegments = totalSamples > 0 ? Math.max(1, Math.ceil(totalSamples / stride)) : 0;

    if (numSegments === 0) {
      if (onChunk) {
        return { streamed: true, paused: false, completedChunks: 0, totalSegments: 0 };
      }
      return mode === 'two_stem'
        ? { mode: 'two_stem', instrumental: { left: new Float32Array(0), right: new Float32Array(0) }, vocals: { left: new Float32Array(0), right: new Float32Array(0) } }
        : { drums: { left: new Float32Array(0), right: new Float32Array(0) }, bass: { left: new Float32Array(0), right: new Float32Array(0) }, other: { left: new Float32Array(0), right: new Float32Array(0) }, vocals: { left: new Float32Array(0), right: new Float32Array(0) } };
    }

    // 串流 Chunk 模式：僅配置固定單區段長度（343,980 samples ≈ 12.4 MiB）滾動緩衝區，徹底移除全曲 4 軌 PCM 配置
    // TRACKS 順序：[0: drums, 1: bass, 2: other, 3: vocals]
    // Chunk payload 固定順序：[vocals, drums, bass, other] => TRACKS 索引 [3, 0, 1, 2]
    const PACK_ORDER_FROM_TRACKS = [3, 0, 1, 2];

    let rollingTracks = onChunk
      ? TRACKS.map(() => ({
          left: new Float32Array(TRAINING_SAMPLES),
          right: new Float32Array(TRAINING_SAMPLES),
        }))
      : null;

    let outputs = onChunk
      ? null
      : mode === 'two_stem'
        ? [
            { left: new Float32Array(totalSamples), right: new Float32Array(totalSamples) }, // [0] instrumental
            { left: new Float32Array(totalSamples), right: new Float32Array(totalSamples) }, // [1] vocals
          ]
        : TRACKS.map(() => ({
            left: new Float32Array(totalSamples),
            right: new Float32Array(totalSamples),
          }));

    let rollingWeights = new Float32Array(TRAINING_SAMPLES);
    let segLeft = new Float32Array(TRAINING_SAMPLES);
    let segRight = new Float32Array(TRAINING_SAMPLES);

    let hasRestoredCarry = false;
    if (onChunk && startChunkIndex > 0 && options?.initialOverlapCarryBuffer instanceof ArrayBuffer) {
      const expectedCarryBytes = (4 * 2 + 1) * overlapSamples * Float32Array.BYTES_PER_ELEMENT;
      if (options.initialOverlapCarryBuffer.byteLength === expectedCarryBytes) {
        const carryView = new Float32Array(options.initialOverlapCarryBuffer);
        for (let t = 0; t < 4; t++) {
          const base = t * 2 * overlapSamples;
          rollingTracks[t].left.set(carryView.subarray(base, base + overlapSamples), 0);
          rollingTracks[t].right.set(carryView.subarray(base + overlapSamples, base + overlapSamples * 2), 0);
        }
        rollingWeights.set(carryView.subarray(8 * overlapSamples, 9 * overlapSamples), 0);
        hasRestoredCarry = true;
      }
    }

    const firstLoopIdx =
      onChunk && startChunkIndex > 0 && !hasRestoredCarry
        ? startChunkIndex - 1
        : onChunk
          ? startChunkIndex
          : 0;

    let completedChunks = startChunkIndex;

    try {
      for (let idx = firstLoopIdx; idx < numSegments; idx++) {
        throwIfAborted(signal);
        if (onChunk && idx >= startChunkIndex && shouldPause?.()) {
          return {
            streamed: true,
            paused: true,
            completedChunks,
            totalSegments: numSegments,
          };
        }

        const start = idx * stride;
        const end = Math.min(start + TRAINING_SAMPLES, totalSamples);
        const segmentLength = end - start;
        const isLastSegment = start + stride >= totalSamples;
        const finalizeCount = isLastSegment ? segmentLength : Math.min(stride, segmentLength);
        const isWarmup = onChunk && idx < startChunkIndex;

        segLeft.fill(0);
        segRight.fill(0);
        for (let i = 0; i < segmentLength; i++) {
          const localIdx = start + i - inputOffsetSample;
          if (localIdx < 0 || localIdx >= leftChannel.length) {
            throw new Error(`音訊片段樣本超出可用輸入範圍：${start + i}`);
          }
          segLeft[i] = leftChannel[localIdx];
          segRight[i] = rightChannel[localIdx];
        }

        const input = prepareModelInput(segLeft, segRight);
        throwIfAborted(signal);

        const waveformTensor = new this.ort.Tensor('float32', input.waveform, [1, 2, TRAINING_SAMPLES]);
        const magSpecTensor = new this.ort.Tensor('float32', input.magSpec, [1, 4, MODEL_SPEC_BINS, MODEL_SPEC_FRAMES]);

        const feeds = {};
        feeds[this.session.inputNames[0]] = waveformTensor;
        if (this.session.inputNames.length > 1) {
          feeds[this.session.inputNames[1]] = magSpecTensor;
        }

        let inferResults = null;
        let payloadBuffer = null;
        let overlapCarryBuffer = null;

        try {
          inferResults = await this.session.run(feeds);
          throwIfAborted(signal);

          let timeData = null, timeShape = null;
          let freqData = null;

          for (const name of this.session.outputNames) {
            const tensor = inferResults[name];
            if (tensor.dims.length === 4 && tensor.dims[2] === 2) {
              timeData = tensor.data;
              timeShape = tensor.dims;
            } else if (tensor.dims.length === 5 && tensor.dims[2] === 4) {
              freqData = tensor.data;
            }
          }

          if (!timeData) {
            throw new Error('Could not find time-domain output tensor');
          }

          let combinedOutputs = null;
          if (freqData) {
            const trackSpecs = standaloneMask(freqData);
            combinedOutputs = [];

            for (let t = 0; t < 4; t++) {
              throwIfAborted(signal);
              const freqOutput = standaloneIspec(trackSpecs[t], TRAINING_SAMPLES);
              const numChannels = timeShape[2];
              const samples = timeShape[3];
              const timeLeft = new Float32Array(samples);
              const timeRight = new Float32Array(samples);

              for (let i = 0; i < samples; i++) {
                timeLeft[i] = timeData[t * numChannels * samples + 0 * samples + i];
                timeRight[i] = timeData[t * numChannels * samples + 1 * samples + i];
              }

              const combined = {
                left: new Float32Array(samples),
                right: new Float32Array(samples)
              };
              for (let i = 0; i < samples; i++) {
                combined.left[i] = timeLeft[i] + (freqOutput.left[i] || 0);
                combined.right[i] = timeRight[i] + (freqOutput.right[i] || 0);
              }
              combinedOutputs.push(combined);
            }
          }

          const numTracks = timeShape[1];
          const numChannels = timeShape[2];
          const samples = timeShape[3];

          const overlapWindow = new Float32Array(segmentLength);
          for (let i = 0; i < segmentLength; i++) {
            const fadeIn = Math.min(i / (stride * 0.5), 1);
            const fadeOut = Math.min((segmentLength - i) / (stride * 0.5), 1);
            overlapWindow[i] = Math.min(fadeIn, fadeOut);
          }

          if (onChunk) {
            for (let t = 0; t < numTracks; t++) {
              const targetRolling = rollingTracks[t];
              for (let i = 0; i < segmentLength; i++) {
                let leftVal, rightVal;
                if (combinedOutputs) {
                  leftVal = combinedOutputs[t].left[i];
                  rightVal = combinedOutputs[t].right[i];
                } else {
                  const leftIdx = t * numChannels * samples + 0 * samples + i;
                  const rightIdx = t * numChannels * samples + 1 * samples + i;
                  leftVal = timeData[leftIdx];
                  rightVal = timeData[rightIdx];
                }
                targetRolling.left[i] += leftVal * overlapWindow[i];
                targetRolling.right[i] += rightVal * overlapWindow[i];
              }
            }
            for (let i = 0; i < segmentLength; i++) {
              rollingWeights[i] += overlapWindow[i];
            }

            if (!isWarmup) {
              for (let t = 0; t < 4; t++) {
                for (let i = 0; i < finalizeCount; i++) {
                  const w = rollingWeights[i];
                  if (w > 0) {
                    rollingTracks[t].left[i] /= w;
                    rollingTracks[t].right[i] /= w;
                  }
                }
              }
              payloadBuffer = new ArrayBuffer(4 * 2 * finalizeCount * Float32Array.BYTES_PER_ELEMENT);
              const payloadView = new Float32Array(payloadBuffer);
              for (let s = 0; s < PACK_ORDER_FROM_TRACKS.length; s++) {
                const trackIdx = PACK_ORDER_FROM_TRACKS[s];
                const base = s * 2 * finalizeCount;
                payloadView.set(rollingTracks[trackIdx].left.subarray(0, finalizeCount), base);
                payloadView.set(rollingTracks[trackIdx].right.subarray(0, finalizeCount), base + finalizeCount);
              }
            }

            if (!isLastSegment) {
              for (let t = 0; t < 4; t++) {
                rollingTracks[t].left.copyWithin(0, stride);
                rollingTracks[t].left.fill(0, TRAINING_SAMPLES - stride);
                rollingTracks[t].right.copyWithin(0, stride);
                rollingTracks[t].right.fill(0, TRAINING_SAMPLES - stride);
              }
              rollingWeights.copyWithin(0, stride);
              rollingWeights.fill(0, TRAINING_SAMPLES - stride);

              if (!isWarmup) {
                overlapCarryBuffer = new ArrayBuffer((4 * 2 + 1) * overlapSamples * Float32Array.BYTES_PER_ELEMENT);
                const carryView = new Float32Array(overlapCarryBuffer);
                for (let t = 0; t < 4; t++) {
                  const base = t * 2 * overlapSamples;
                  carryView.set(rollingTracks[t].left.subarray(0, overlapSamples), base);
                  carryView.set(rollingTracks[t].right.subarray(0, overlapSamples), base + overlapSamples);
                }
                carryView.set(rollingWeights.subarray(0, overlapSamples), 8 * overlapSamples);
              }
            } else {
              rollingWeights.fill(0);
              for (let t = 0; t < 4; t++) {
                rollingTracks[t].left.fill(0);
                rollingTracks[t].right.fill(0);
              }
            }
          } else {
            for (let t = 0; t < numTracks; t++) {
              const targetOut = mode === 'two_stem' ? outputs[t === 3 ? 1 : 0] : outputs[t];
              for (let i = 0; i < segmentLength && start + i < totalSamples; i++) {
                let leftVal, rightVal;
                if (combinedOutputs) {
                  leftVal = combinedOutputs[t].left[i];
                  rightVal = combinedOutputs[t].right[i];
                } else {
                  const leftIdx = t * numChannels * samples + 0 * samples + i;
                  const rightIdx = t * numChannels * samples + 1 * samples + i;
                  leftVal = timeData[leftIdx];
                  rightVal = timeData[rightIdx];
                }
                targetOut.left[start + i] += leftVal * overlapWindow[i];
                targetOut.right[start + i] += rightVal * overlapWindow[i];
              }
            }

            for (let i = 0; i < segmentLength && start + i < totalSamples; i++) {
              rollingWeights[i] += overlapWindow[i];
            }
            for (let t = 0; t < outputs.length; t++) {
              for (let i = 0; i < finalizeCount; i++) {
                const w = rollingWeights[i];
                if (w > 0) {
                  outputs[t].left[start + i] /= w;
                  outputs[t].right[start + i] /= w;
                }
              }
            }
            if (!isLastSegment) {
              rollingWeights.copyWithin(0, stride);
              rollingWeights.fill(0, TRAINING_SAMPLES - stride);
            }
          }
          combinedOutputs = null;
        } finally {
          safeDisposeTensor(waveformTensor);
          safeDisposeTensor(magSpecTensor);
          if (inferResults) {
            for (const tensor of Object.values(inferResults)) {
              safeDisposeTensor(tensor);
            }
            inferResults = null;
          }
        }

        if (!isWarmup) {
          if (onChunk && payloadBuffer) {
            await onChunk({
              chunkIndex: idx,
              startSample: start,
              endSample: start + finalizeCount,
              frameCount: finalizeCount,
              totalSegments: numSegments,
              payloadBuffer,
              overlapCarryBuffer,
            });
            payloadBuffer = null;
            overlapCarryBuffer = null;
          }
          completedChunks = idx + 1;
          this.onProgress({
            progress: completedChunks / numSegments,
            currentSegment: completedChunks,
            totalSegments: numSegments,
          });
          if (onChunk && !isLastSegment && shouldPause?.()) {
            return {
              streamed: true,
              paused: true,
              completedChunks,
              totalSegments: numSegments,
            };
          }
        }

        await yieldToEventLoop();
      }

      throwIfAborted(signal);
      rollingWeights = null;
      rollingTracks = null;
      segLeft = null;
      segRight = null;

      if (onChunk) {
        return {
          streamed: true,
          paused: false,
          completedChunks,
          totalSegments: numSegments,
        };
      }

      if (mode === 'two_stem') {
        return {
          mode: 'two_stem',
          instrumental: outputs[0],
          vocals: outputs[1]
        };
      }

      return {
        drums: outputs[0],
        bass: outputs[1],
        other: outputs[2],
        vocals: outputs[3]
      };
    } catch (error) {
      outputs = null;
      rollingTracks = null;
      rollingWeights = null;
      segLeft = null;
      segRight = null;
      throw error;
    }
  }
}
