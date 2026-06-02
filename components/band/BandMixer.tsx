"use client";

import { useRef, useState } from "react";
import { BandSession, BandTrack } from "@/lib/band/bandTypes";
import { createBandTrackFromFile } from "@/lib/band/bandSession";
import { TrackCard } from "./TrackCard";
import { SelectedTracksBar } from "./SelectedTracksBar";

type Props = {
  session: BandSession;
  onSessionChange: (s: BandSession) => void;
};

export function BandMixer({ session, onSessionChange }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);

  const updateSession = (patch: Partial<BandSession>) =>
    onSessionChange({ ...session, ...patch });

  const updateTrack = (id: string, patch: Partial<BandTrack>) =>
    updateSession({
      tracks: session.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    });

  const batchUpdate = (ids: string[], patch: Partial<BandTrack>) =>
    updateSession({
      tracks: session.tracks.map((t) => (ids.includes(t.id) ? { ...t, ...patch } : t)),
    });

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setLoading(true);
    const newTracks: BandTrack[] = [];
    for (const file of Array.from(files)) {
      newTracks.push(await createBandTrackFromFile(file));
    }
    updateSession({ tracks: [...session.tracks, ...newTracks] });
    setLoading(false);
  };

  const selectedIds = session.tracks.filter((t) => t.selected).map((t) => t.id);

  return (
    <div className="grid" style={{ gap: 16 }}>

      {/* ── 全域控制 ── */}
      <div className="card row" style={{ flexWrap: "wrap", gap: 16 }}>
        <label className="row">
          <span className="label">全域 BPM</span>
          <input
            className="input"
            type="number"
            min={20} max={300} step={1}
            value={session.globalBpm}
            style={{ width: 80 }}
            onChange={(e) => updateSession({ globalBpm: Math.max(20, Math.min(300, Number(e.target.value) || 120)) })}
          />
        </label>
        <button
          className="btn primary"
          disabled={loading}
          onClick={() => fileInputRef.current?.click()}
        >
          {loading ? "載入中…" : "＋ 載入音檔"}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*"
          multiple
          style={{ display: "none" }}
          onChange={(e) => { void handleFiles(e.target.files); e.target.value = ""; }}
        />
      </div>

      {/* ── 多選控制列 ── */}
      <SelectedTracksBar
        tracks={session.tracks}
        onPlaySelected={() => batchUpdate(selectedIds, { status: "playing" })}
        onPauseSelected={() => batchUpdate(selectedIds, { status: "paused" })}
        onStopSelected={() => batchUpdate(selectedIds, { status: "stopped", playheadSec: 0 })}
      />

      {/* ── 音軌列表 ── */}
      {session.tracks.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: "48px 16px" }}>
          <p className="small" style={{ opacity: 0.5, margin: 0 }}>尚未載入任何音軌</p>
          <p className="small" style={{ opacity: 0.35, marginTop: 6 }}>點擊「＋ 載入音檔」選取一或多個音訊檔案</p>
        </div>
      ) : (
        <div className="grid" style={{ gap: 12 }}>
          {session.tracks.map((track) => (
            <TrackCard
              key={track.id}
              track={track}
              onChange={(patch) => updateTrack(track.id, patch)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
