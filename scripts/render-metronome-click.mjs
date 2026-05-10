#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const args = parseArgs(process.argv.slice(2));

const sampleRate = numberArg(args, "sampleRate", 44100);
const bpm = numberArg(args, "bpm", 132);
const bars = numberArg(args, "bars", 4);
const beatsPerBar = numberArg(args, "beatsPerBar", 4);
const wave = stringArg(args, "wave", "square");
const accentFreq = numberArg(args, "accentFreq", 2000);
const beatFreq = numberArg(args, "beatFreq", 1400);
const accentPeak = numberArg(args, "accentPeak", 0.9);
const beatPeak = numberArg(args, "beatPeak", 0.55);
const attack = numberArg(args, "attack", 0.0015);
const decay = numberArg(args, "decay", 0.035);
const clickDuration = numberArg(args, "duration", 0.04);
const out = stringArg(args, "out", "tmp/metronome-click.wav");
const shouldPlay = boolArg(args.play, false);

const totalBeats = bars * beatsPerBar;
const secondsPerBeat = 60 / bpm;
const totalDuration = totalBeats * secondsPerBeat + 0.5;
const totalSamples = Math.ceil(totalDuration * sampleRate);

const samples = new Float32Array(totalSamples);

for (let beat = 0; beat < totalBeats; beat++) {
  const isAccent = beat % beatsPerBar === 0;
  const startTime = beat * secondsPerBeat;

  renderClick(samples, {
    sampleRate,
    startTime,
    duration: clickDuration,
    frequency: isAccent ? accentFreq : beatFreq,
    peak: isAccent ? accentPeak : beatPeak,
    attack,
    decay,
    wave,
  });
}

normalizeIfNeeded(samples, 0.95);

const wav = encodeWavMono16(samples, sampleRate);

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, wav);

console.log(`已輸出：${out}`);
console.log(`BPM=${bpm}, bars=${bars}, beatsPerBar=${beatsPerBar}`);
console.log(`wave=${wave}, accent=${accentFreq}Hz, beat=${beatFreq}Hz`);
console.log(`attack=${attack}s, decay=${decay}s, duration=${clickDuration}s`);

if (shouldPlay) {
  playFile(out);
}

function renderClick(buffer, opts) {
  const {
    sampleRate,
    startTime,
    duration,
    frequency,
    peak,
    attack,
    decay,
    wave,
  } = opts;

  const start = Math.floor(startTime * sampleRate);
  const length = Math.floor(duration * sampleRate);

  for (let i = 0; i < length; i++) {
    const index = start + i;
    if (index < 0 || index >= buffer.length) continue;

    const t = i / sampleRate;
    const phase = 2 * Math.PI * frequency * t;

    const osc = oscillatorSample(wave, phase);

    let env;
    if (t < attack) {
      env = peak * (t / Math.max(attack, 0.000001));
    } else {
      const d = t - attack;
      env = peak * Math.exp(-d / Math.max(decay / 5, 0.000001));
    }

    buffer[index] += osc * env;
  }
}

function oscillatorSample(wave, phase) {
  switch (wave) {
    case "sine":
      return Math.sin(phase);

    case "square":
      return Math.sin(phase) >= 0 ? 1 : -1;

    case "triangle":
      return (2 / Math.PI) * Math.asin(Math.sin(phase));

    case "sawtooth":
      return 2 * (phase / (2 * Math.PI) - Math.floor(phase / (2 * Math.PI) + 0.5));

    case "noise":
      return Math.random() * 2 - 1;

    default:
      throw new Error(`不支援的 wave：${wave}`);
  }
}

function normalizeIfNeeded(samples, targetPeak) {
  let max = 0;
  for (const s of samples) {
    max = Math.max(max, Math.abs(s));
  }

  if (max <= targetPeak || max === 0) return;

  const gain = targetPeak / max;
  for (let i = 0; i < samples.length; i++) {
    samples[i] *= gain;
  }
}

function encodeWavMono16(samples, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);

  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (const sample of samples) {
    const clipped = Math.max(-1, Math.min(1, sample));
    const int16 = clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff;
    buffer.writeInt16LE(Math.round(int16), offset);
    offset += 2;
  }

  return buffer;
}

function playFile(file) {
  const platform = process.platform;

  const command =
    platform === "darwin"
      ? "afplay"
      : platform === "win32"
        ? "powershell"
        : "aplay";

  const commandArgs =
    platform === "win32"
      ? ["-c", `(New-Object Media.SoundPlayer "${file}").PlaySync();`]
      : [file];

  const child = spawn(command, commandArgs, {
    stdio: "inherit",
  });

  child.on("error", (err) => {
    console.error(`播放失敗：${err.message}`);
    console.error(`檔案已存好，可以手動開啟：${file}`);
  });
}

function parseArgs(argv) {
  const result = {};

  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];

    if (!item.startsWith("--")) continue;

    const key = item.slice(2);
    const next = argv[i + 1];

    if (!next || next.startsWith("--")) {
      result[key] = true;
    } else {
      result[key] = next;
      i++;
    }
  }

  return result;
}

function numberArg(args, key, fallback) {
  const value = args[key];
  if (value === undefined) return fallback;

  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`參數 --${key} 必須是數字，目前是：${value}`);
  }

  return n;
}

function stringArg(args, key, fallback) {
  return args[key] === undefined ? fallback : String(args[key]);
}

function boolArg(value, fallback) {
  if (value === undefined) return fallback;
  if (value === true) return true;
  return ["1", "true", "yes", "y"].includes(String(value).toLowerCase());
}