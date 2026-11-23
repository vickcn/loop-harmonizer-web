import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("Band Mixer keeps primary playback visible while performance controls use progressive disclosure", () => {
  const songCard = read("components/band/SongCard.tsx");
  assert.match(songCard, /SongCardHeader/);
  assert.match(songCard, /song-transport/);
  assert.match(songCard, /className="song-performance-panel"/);
  assert.match(songCard, /調整音色與速度/);
  assert.match(songCard, /song-separation-panel/);
  assert.match(songCard, /音軌分離與混音/);
});

test("playhead provides an accessible A/B loop region without replacing the primary transport", () => {
  const playhead = read("components/band/TrackPlayhead.tsx");
  const songCard = read("components/band/SongCard.tsx");
  const engine = read("lib/band/multiTrackEngine.ts");
  assert.match(playhead, /循環區段/);
  assert.match(playhead, /track-waveform-bars/);
  assert.match(playhead, /循環起點 A/);
  assert.match(playhead, /循環終點 B/);
  assert.match(playhead, /track-loop-handle is-start/);
  assert.match(playhead, /track-loop-handle is-end/);
  assert.doesNotMatch(playhead, /設 A|設 B/);
  assert.match(songCard, /onSetLoopStart/);
  assert.match(songCard, /onSetLoopEnd/);
  assert.match(engine, /getTrackWaveformPeaks/);
  assert.match(engine, /loopStartSec/);
  assert.match(engine, /loopEndSec/);
});

test("Stem Mixer delegates each channel to a single responsive channel strip without changing callbacks", () => {
  const mixer = read("components/band/StemMixer.tsx");
  const strip = read("components/band/StemChannelStrip.tsx");
  assert.match(mixer, /<StemChannelStrip/);
  assert.match(mixer, /onToggleMute=\{onToggleMute\}/);
  assert.match(mixer, /onToggleSolo=\{onToggleSolo\}/);
  assert.match(strip, /下載 \$\{label\} WAV/);
  assert.match(strip, /onChange\(channel\.id, \{ volume:/);
});

test("Band Mixer tokens preserve semantic blue, green, amber and destructive colours", () => {
  const css = read("app/globals.css");
  for (const token of ["--action-primary", "--volume", "--tempo", "--danger", "--touch-target"]) {
    assert.match(css, new RegExp(token));
  }
  assert.match(css, /@media \(pointer: coarse\)/);
  assert.match(css, /song-performance-panel/);
  assert.match(css, /stem-row-heading/);
});

test("Project and bulk controls retain their labelled landmarks", () => {
  const mixer = read("components/band/BandMixer.tsx");
  const toolbar = read("components/band/ProjectToolbar.tsx");
  assert.match(mixer, /aria-label="載入歌曲與工作區工具"/);
  assert.match(mixer, /aria-label="批次播放控制"/);
  assert.match(toolbar, /aria-label="專案主要操作"/);
});
