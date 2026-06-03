"use client";

import { useState } from "react";
import { MetronomeSoundEditor } from "./MetronomeSoundEditor";
import { MetronomeSound } from "@/lib/metronome/metronomeSound";

type Props = {
  enabled: boolean;
  accentFirstBeat: boolean;
  metronomeVolume: number;
  audioVolume: number;
  standaloneIsPlaying: boolean;
  onStandalonePlay: () => void;
  onStandaloneStop: () => void;
  onEnabledChange: (v: boolean) => void;
  onAccentChange: (v: boolean) => void;
  onMetronomeVolumeChange: (v: number) => void;
  onAudioVolumeChange: (v: number) => void;
  // sound
  sounds: MetronomeSound[];
  currentSoundId: string;
  onSoundChange: (id: string) => void;
  onCustomSoundsChange: (sounds: MetronomeSound[]) => void;
  onPreviewSound: (sound: MetronomeSound) => void;
};

export function MetronomePanel({
  enabled, accentFirstBeat, metronomeVolume, audioVolume,
  standaloneIsPlaying, onStandalonePlay, onStandaloneStop,
  onEnabledChange, onAccentChange, onMetronomeVolumeChange, onAudioVolumeChange,
  sounds, currentSoundId, onSoundChange, onCustomSoundsChange, onPreviewSound,
}: Props) {
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingSound, setEditingSound] = useState<MetronomeSound | null>(null);

  const currentSound = sounds.find((s) => s.id === currentSoundId) ?? sounds[0];
  const customSounds = sounds.filter((s) => !s.builtIn);

  const openNew = () => {
    setEditingSound(null);
    setEditorOpen(true);
  };

  const openEdit = () => {
    if (!currentSound) return;
    // built-in: clone with fresh id so it saves as new custom sound
    const forEdit = currentSound.builtIn
      ? { ...currentSound, id: `custom-${Date.now()}`, builtIn: undefined }
      : currentSound;
    setEditingSound(forEdit);
    setEditorOpen(true);
  };

  const handleSave = (saved: MetronomeSound) => {
    const isExisting = customSounds.some((s) => s.id === saved.id);
    const next = isExisting
      ? customSounds.map((s) => (s.id === saved.id ? saved : s))
      : [...customSounds, saved];
    onCustomSoundsChange(next);
    onSoundChange(saved.id);
    setEditorOpen(false);
  };

  const handleDelete = () => {
    if (!currentSound || currentSound.builtIn) return;
    const next = customSounds.filter((s) => s.id !== currentSoundId);
    onCustomSoundsChange(next);
    // fall back to first built-in
    const fallback = sounds.find((s) => s.builtIn);
    if (fallback) onSoundChange(fallback.id);
  };

  return (
    <>
      <div className="card grid">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>節拍器</h2>
        </div>

        {/* on/off + accent */}
        <div className="row">
          <label className="row" style={{ gap: 8, cursor: "pointer" }}>
            <input type="checkbox" checked={enabled} onChange={(e) => onEnabledChange(e.target.checked)} />
            <span>開啟節拍器</span>
          </label>
          <label className="row" style={{ gap: 8, cursor: "pointer" }}>
            <input type="checkbox" checked={accentFirstBeat} disabled={!enabled} onChange={(e) => onAccentChange(e.target.checked)} />
            <span style={{ opacity: enabled ? 1 : 0.4 }}>第一拍重音</span>
          </label>
        </div>

        {/* volume sliders */}
        <div className="row" style={{ flexWrap: "wrap", gap: 16 }}>
          <label className="row">
            <span className="label">節拍器音量</span>
            <input
              type="range" min={0} max={1} step={0.01}
              value={metronomeVolume}
              disabled={!enabled}
              onChange={(e) => onMetronomeVolumeChange(Number(e.target.value))}
              style={{ width: 120 }}
            />
            <span className="small" style={{ minWidth: 36 }}>{Math.round(metronomeVolume * 100)}%</span>
          </label>
          <label className="row">
            <span className="label">音檔音量</span>
            <input
              type="range" min={0} max={1} step={0.01}
              value={audioVolume}
              onChange={(e) => onAudioVolumeChange(Number(e.target.value))}
              style={{ width: 120 }}
            />
            <span className="small" style={{ minWidth: 36 }}>{Math.round(audioVolume * 100)}%</span>
          </label>
        </div>

        {/* sound selector */}
        <div className="row" style={{ flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <span className="label">音色</span>
          <select
            value={currentSoundId}
            onChange={(e) => onSoundChange(e.target.value)}
            style={{ flex: "1 1 160px", minWidth: 0 }}
          >
            {sounds.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}{s.builtIn ? "" : " ✎"}
              </option>
            ))}
          </select>
          <button className="btn" style={{ padding: "4px 10px" }} onClick={openNew}>＋ 新增</button>
          <button
            className="btn"
            style={{ padding: "4px 10px" }}
            title={currentSound?.builtIn ? "以此音色為基礎建立自訂音色" : "編輯音色"}
            onClick={openEdit}
          >
            {currentSound?.builtIn ? "✎ 複製編輯" : "✎ 編輯"}
          </button>
          <button
            className="btn danger"
            style={{ padding: "4px 10px" }}
            disabled={currentSound?.builtIn}
            title={currentSound?.builtIn ? "內建音色不可刪除" : "刪除"}
            onClick={handleDelete}
          >
            × 刪除
          </button>
        </div>

        {enabled && (
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 4 }}>
            <button
              className={`btn${standaloneIsPlaying ? " danger" : " primary"}`}
              style={{ padding: "6px 14px" }}
              onClick={standaloneIsPlaying ? onStandaloneStop : onStandalonePlay}
            >
              {standaloneIsPlaying ? "⏹ 停止" : "▶ 純節拍器"}
            </button>
          </div>
        )}
      </div>

      {editorOpen && (
        <MetronomeSoundEditor
          initial={editingSound}
          onSave={handleSave}
          onCancel={() => setEditorOpen(false)}
          onPreview={onPreviewSound}
        />
      )}
    </>
  );
}
