import assert from "node:assert/strict";
import test from "node:test";

import { createBandSong, getEffectivePlaybackRate } from "../lib/band/songModel.ts";
import {
  EMPTY_MIXER_SELECTION,
  applyResetKey,
  applyResetMix,
  applyResetSpeed,
  describePlaybackError,
  getResetKeyPatch,
  getResetMixPatch,
  getResetSpeedPatch,
  resolveShortcutAction,
  sanitizeMixerSelection,
  toggleMuteBySelection,
  toggleSoloBySelection,
} from "../lib/band/mixerShortcuts.ts";

function createSongWithStems(id, name, originalBpm = 120) {
  const song = createBandSong({
    id,
    name,
    sourceAudioId: `${id}_orig`,
    originalBpm,
    durationSec: 180,
  });
  song.playbackSource = "stems";
  song.stemIds = [`${id}_vocals`, `${id}_drums`, `${id}_bass`, `${id}_other`];
  song.stemChannels = [
    { id: `${id}_vocals`, songId: id, stemType: "vocals", volume: 0.9, muted: false, solo: false },
    { id: `${id}_drums`, songId: id, stemType: "drums", volume: 0.8, muted: false, solo: false },
    { id: `${id}_bass`, songId: id, stemType: "bass", volume: 0.7, muted: false, solo: false },
    { id: `${id}_other`, songId: id, stemType: "other", volume: 0.6, muted: false, solo: false },
  ];
  return song;
}

test("sanitizeMixerSelection clears invalid songId or stemId after deletion", () => {
  const songA = createSongWithStems("song_a", "A");
  const songB = createSongWithStems("song_b", "B");

  assert.deepEqual(
    sanitizeMixerSelection({ songId: "song_a", stemId: "song_a_vocals" }, [songA, songB]),
    { songId: "song_a", stemId: "song_a_vocals" },
  );
  // 刪除 vocals stem 後應清除 stemId 但保留 songId
  songA.stemChannels = songA.stemChannels.filter((c) => c.id !== "song_a_vocals");
  assert.deepEqual(
    sanitizeMixerSelection({ songId: "song_a", stemId: "song_a_vocals" }, [songA, songB]),
    { songId: "song_a", stemId: null },
  );
  // 刪除 songA 後應完全清空選取狀態
  assert.deepEqual(
    sanitizeMixerSelection({ songId: "song_a", stemId: null }, [songB]),
    EMPTY_MIXER_SELECTION,
  );
});

test("resolveShortcutAction handles Space, Alt combinations, macOS event.code, and conflict guards", () => {
  const rangeEl = { tagName: "INPUT", type: "range" };
  const textEl = { tagName: "INPUT", type: "text" };
  const numberEl = { tagName: "INPUT", type: "number" };
  const textareaEl = { tagName: "TEXTAREA" };
  const selectEl = { tagName: "SELECT" };
  const buttonEl = { tagName: "BUTTON" };
  const contentEditableEl = { tagName: "DIV", isContentEditable: true };
  const dialogChildEl = { tagName: "DIV", closest: (sel) => (sel.includes("dialog") ? {} : null) };

  // 滑桿與一般區域可觸發 Space 播放/暫停
  assert.equal(resolveShortcutAction({ code: "Space", key: " ", target: rangeEl }), "toggle-play");
  assert.equal(resolveShortcutAction({ code: "Space", key: " ", target: { tagName: "ARTICLE" } }), "toggle-play");

  // 衝突元素與 dialog 不執行歌曲層級 Space
  assert.equal(resolveShortcutAction({ code: "Space", key: " ", target: textEl }), null);
  assert.equal(resolveShortcutAction({ code: "Space", key: " ", target: numberEl }), null);
  assert.equal(resolveShortcutAction({ code: "Space", key: " ", target: textareaEl }), null);
  assert.equal(resolveShortcutAction({ code: "Space", key: " ", target: selectEl }), null);
  assert.equal(resolveShortcutAction({ code: "Space", key: " ", target: buttonEl }), null);
  assert.equal(resolveShortcutAction({ code: "Space", key: " ", target: contentEditableEl }), null);
  assert.equal(resolveShortcutAction({ code: "Space", key: " ", target: dialogChildEl }), null);

  // repeat, isComposing, defaultPrevented 與 Ctrl/Meta 均應忽略
  assert.equal(resolveShortcutAction({ code: "Space", key: " ", repeat: true, target: rangeEl }), null);
  assert.equal(resolveShortcutAction({ code: "Space", key: " ", isComposing: true, target: rangeEl }), null);
  assert.equal(resolveShortcutAction({ code: "Space", key: " ", defaultPrevented: true, target: rangeEl }), null);
  assert.equal(resolveShortcutAction({ code: "KeyM", altKey: true, ctrlKey: true, target: rangeEl }), null);

  // 不應攔截方向鍵（交給原生 input range）
  assert.equal(resolveShortcutAction({ code: "ArrowLeft", key: "ArrowLeft", target: rangeEl }), null);
  assert.equal(resolveShortcutAction({ code: "ArrowRight", key: "ArrowRight", target: rangeEl }), null);
  assert.equal(resolveShortcutAction({ code: "ArrowUp", key: "ArrowUp", target: rangeEl }), null);
  assert.equal(resolveShortcutAction({ code: "ArrowDown", key: "ArrowDown", target: rangeEl }), null);

  // macOS Option+字母 會產出 µ, ˚, ˜, Ω 等字元，應靠 event.code 精準對應
  assert.equal(resolveShortcutAction({ code: "KeyM", key: "µ", altKey: true, target: rangeEl }), "toggle-mute");
  assert.equal(resolveShortcutAction({ code: "KeyK", key: "˚", altKey: true, target: rangeEl }), "toggle-solo");
  assert.equal(resolveShortcutAction({ code: "KeyL", key: "¬", altKey: true, target: rangeEl }), "toggle-loop");
  assert.equal(resolveShortcutAction({ key: "l", altKey: true, target: rangeEl }), "toggle-loop");
  assert.equal(resolveShortcutAction({ code: "KeyN", key: "˜", altKey: true, target: rangeEl }), "open-upload");
  assert.equal(resolveShortcutAction({ code: "KeyZ", key: "Ω", altKey: true, target: rangeEl }), "reset-speed");
  assert.equal(resolveShortcutAction({ code: "KeyX", key: "≈", altKey: true, target: rangeEl }), "reset-key");
  assert.equal(resolveShortcutAction({ code: "KeyC", key: "ç", altKey: true, target: rangeEl }), "reset-mix");
  assert.equal(resolveShortcutAction({ code: "KeyA", key: "å", altKey: true, target: rangeEl }), "seek-start");

  // 文字輸入框與 dialog 內不觸發 Alt 快捷鍵
  assert.equal(resolveShortcutAction({ code: "KeyM", altKey: true, target: textEl }), null);
  assert.equal(resolveShortcutAction({ code: "KeyN", altKey: true, target: dialogChildEl }), null);
});

test("Alt+M toggles selected stem mute or song mute without affecting other songs", () => {
  const songA = createSongWithStems("song_a", "A");
  const songB = createSongWithStems("song_b", "B");

  // 選取 songA 的 vocals 時，Alt+M 只切換 songA vocals
  const resStem = toggleMuteBySelection([songA, songB], { songId: "song_a", stemId: "song_a_vocals" });
  assert.equal(resStem.changedSong?.stemChannels[0].muted, true);
  assert.equal(resStem.changedSong?.stemChannels[1].muted, false);
  assert.equal(resStem.changedSong?.muted, false);
  assert.equal(resStem.songs[1].stemChannels[0].muted, false);

  // 只選取 songB（stemId = null）時，Alt+M 切換 songB 整首靜音
  const resSong = toggleMuteBySelection(resStem.songs, { songId: "song_b", stemId: null });
  assert.equal(resSong.changedSong?.id, "song_b");
  assert.equal(resSong.changedSong?.muted, true);
  assert.equal(resSong.songs[0].muted, false);
});

test("Alt+K toggles selected stem solo and warns cleanly when only a song is selected", () => {
  const songA = createSongWithStems("song_a", "A");
  const songB = createSongWithStems("song_b", "B");

  // 選取 stem 時，切換該 stem solo
  const resStem = toggleSoloBySelection([songA, songB], { songId: "song_a", stemId: "song_a_vocals" });
  assert.equal(resStem.changedSong?.stemChannels[0].solo, true);
  assert.equal(resStem.songs[1].stemChannels[0].solo, false);

  // 只選取 song 而未選 stem 時，不執行並提供提示
  const resSongOnly = toggleSoloBySelection(resStem.songs, { songId: "song_a", stemId: null });
  assert.equal(resSongOnly.changedSong, null);
  assert.ok(resSongOnly.message.length > 0);
});

test("Alt+Z, Alt+X and Alt+C restore speed, key and mix defaults within target scopes", () => {
  const song = createSongWithStems("song_a", "A", 128);
  song.tempoMode = "manual-rate";
  song.targetBpm = 140;
  song.manualRate = 1.25;
  song.fineRateOffset = 0.03;
  song.savedRates = [1, 1.15, 1.25];
  song.keyShiftSemitones = 4;
  song.masterVolume = 0.6;
  song.muted = true;
  song.playheadSec = 42;
  song.stemChannels[0].muted = true;
  song.stemChannels[1].solo = true;

  // Alt+Z：恢復 1.000x，清除手動倍率與微調，保留 Key 與 savedRates
  const speedPatched = { ...song, ...getResetSpeedPatch(song) };
  assert.equal(getEffectivePlaybackRate(speedPatched), 1.0);
  assert.equal(speedPatched.keyShiftSemitones, 4);
  assert.deepEqual(speedPatched.savedRates, [1, 1.15, 1.25]);

  // Alt+X：Key 設為 0，保留倍率、BPM 與音量
  const keyPatched = { ...song, ...getResetKeyPatch() };
  assert.equal(keyPatched.keyShiftSemitones, 0);
  assert.equal(keyPatched.manualRate, 1.25);
  assert.equal(keyPatched.targetBpm, 140);
  assert.equal(keyPatched.masterVolume, 0.6);

  // Alt+C：恢復預設音量並清除 Mute/Solo，保留分離分軌、BPM、Key 與播放位置
  const mixPatched = { ...song, ...getResetMixPatch(song) };
  assert.equal(mixPatched.masterVolume, 1);
  assert.equal(mixPatched.muted, false);
  assert.equal(mixPatched.stemIds.length, 4);
  assert.equal(mixPatched.keyShiftSemitones, 4);
  assert.equal(mixPatched.playheadSec, 42);
  assert.ok(mixPatched.stemChannels.every((ch) => ch.volume === 1 && !ch.muted && !ch.solo));
});

test("applyReset helpers avoid fabricating changes when already at default", () => {
  const baseSong = createSongWithStems("song_def", "DefaultSong", 120);
  const defaultSong = {
    ...baseSong,
    stemChannels: baseSong.stemChannels.map((ch) => ({ ...ch, volume: 1, muted: false, solo: false })),
  };

  const speedUnchanged = applyResetSpeed(defaultSong);
  assert.equal(speedUnchanged.changed, false);
  assert.equal(speedUnchanged.patch, null);
  assert.ok(speedUnchanged.message.includes("無需變更"));

  const keyUnchanged = applyResetKey(defaultSong);
  assert.equal(keyUnchanged.changed, false);
  assert.equal(keyUnchanged.patch, null);
  assert.ok(keyUnchanged.message.includes("無需變更"));

  const mixUnchanged = applyResetMix(defaultSong);
  assert.equal(mixUnchanged.changed, false);
  assert.equal(mixUnchanged.patch, null);
  assert.ok(mixUnchanged.message.includes("無需變更"));

  const modified = {
    ...defaultSong,
    tempoMode: "manual-rate",
    manualRate: 1.15,
    fineRateOffset: 0.02,
    keyShiftSemitones: -2,
    muted: true,
    stemChannels: defaultSong.stemChannels.map((ch, idx) => (idx === 0 ? { ...ch, volume: 0.5, solo: true } : ch)),
  };

  const speedChanged = applyResetSpeed(modified);
  assert.equal(speedChanged.changed, true);
  assert.ok(speedChanged.patch);
  assert.equal(getEffectivePlaybackRate({ ...modified, ...speedChanged.patch }), 1.0);
  assert.ok(speedChanged.message.includes("已恢復原始速度"));

  const keyChanged = applyResetKey(modified);
  assert.equal(keyChanged.changed, true);
  assert.deepEqual(keyChanged.patch, { keyShiftSemitones: 0 });
  assert.ok(keyChanged.message.includes("已恢復原始 Key"));

  const mixChanged = applyResetMix(modified);
  assert.equal(mixChanged.changed, true);
  assert.equal(mixChanged.patch?.masterVolume, 1);
  assert.equal(mixChanged.patch?.muted, false);
  assert.ok(mixChanged.patch?.stemChannels?.every((ch) => ch.volume === 1 && !ch.muted && !ch.solo));
  assert.ok(mixChanged.message.includes("已恢復混音預設"));
});

test("describePlaybackError formats readable messages for autoplay, network, generic and empty errors", () => {
  assert.ok(describePlaybackError(new Error("NotAllowedError: play() failed")).includes("阻擋自動啟動音訊引擎"));
  assert.ok(describePlaybackError(new Error("Failed to fetch soundtouch.js")).includes("音訊處理模組載入失敗"));
  assert.equal(describePlaybackError(new Error("AudioBuffer missing")), "無法啟動播放：AudioBuffer missing");
  assert.equal(describePlaybackError(""), "音訊引擎啟動失敗，請重試。");
});
