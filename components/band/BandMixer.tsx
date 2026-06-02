"use client";

import { useEffect, useRef, useState } from "react";
import { BandSession, BandTrack, TrackSyncMode } from "@/lib/band/bandTypes";
import { createDefaultBandSession } from "@/lib/band/bandSession";
import { MultiTrackEngine } from "@/lib/band/multiTrackEngine";
import { TrackCard } from "./TrackCard";
import { SelectedTracksBar } from "./SelectedTracksBar";

export function BandMixer() {
  const [session, setSession] = useState<BandSession>(createDefaultBandSession);
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const engineRef = useRef<MultiTrackEngine | null>(null);

  const getEngine = (): MultiTrackEngine => {
    if (!engineRef.current) {
      const eng = new MultiTrackEngine();
      eng.onTrackEnded = (trackId) => {
        setSession((prev) => ({
          ...prev,
          tracks: prev.tracks.map((t) =>
            t.id === trackId ? { ...t, status: "stopped", playheadSec: 0 } : t
          ),
        }));
      };
      engineRef.current = eng;
    }
    return engineRef.current;
  };

  // Dispose on unmount
  useEffect(() => {
    return () => {
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, []);

  // Position update loop — 100ms interval, functional setSession avoids stale closures
  useEffect(() => {
    const id = setInterval(() => {
      const eng = engineRef.current;
      if (!eng) return;
      setSession((prev) => {
        const hasPlaying = prev.tracks.some((t) => t.status === "playing");
        if (!hasPlaying) return prev;
        let changed = false;
        const tracks = prev.tracks.map((t) => {
          if (t.status !== "playing") return t;
          const pos = eng.getTrackPosition(t.id);
          if (Math.abs(pos - t.playheadSec) < 0.03) return t;
          changed = true;
          return { ...t, playheadSec: pos };
        });
        return changed ? { ...prev, tracks } : prev;
      });
    }, 100);
    return () => clearInterval(id);
  }, []);

  // File upload: single decode via engine, build BandTrack from result
  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setLoading(true);
    const eng = getEngine();
    for (const file of Array.from(files)) {
      const id = `track_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      try {
        const durationSec = await eng.loadTrack(id, file);
        const track: BandTrack = {
          id,
          name: file.name.replace(/\.[^.]+$/, ""),
          fileName: file.name,
          originalBpm: 120,
          baseRate: 1.0,
          volume: 1.0,
          muted: false,
          selected: false,
          playheadSec: 0,
          durationSec,
          status: "stopped",
          syncMode: "free",
          loop: false,
        };
        setSession((prev) => ({ ...prev, tracks: [...prev.tracks, track] }));
      } catch {
        // unsupported format — skip silently
      }
    }
    setLoading(false);
  };

  // Per-track change handler — intercepts engine-relevant fields
  const updateTrack = async (id: string, patch: Partial<BandTrack>) => {
    const eng = getEngine();

    if ("status" in patch) {
      if (patch.status === "playing") await eng.playTrack(id);
      else if (patch.status === "paused") eng.pauseTrack(id);
      else if (patch.status === "stopped") eng.stopTrack(id);
    }

    // User-initiated seek (not a status change carrying playheadSec: 0)
    if ("playheadSec" in patch && !("status" in patch)) {
      await eng.seekTrack(id, patch.playheadSec!);
    }

    if ("volume" in patch) eng.setVolume(id, patch.volume!);
    if ("muted" in patch) eng.setMuted(id, patch.muted!);
    if ("baseRate" in patch) eng.setPlaybackRate(id, patch.baseRate!);
    if ("loop" in patch) eng.setLoop(id, patch.loop!);

    setSession((prev) => ({
      ...prev,
      tracks: prev.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    }));
  };

  const selectedIds = session.tracks.filter((t) => t.selected).map((t) => t.id);

  const handlePlaySelected = async () => {
    const eng = getEngine();
    await eng.playTracks(selectedIds);
    setSession((prev) => ({
      ...prev,
      tracks: prev.tracks.map((t) =>
        t.selected ? { ...t, status: "playing" as const } : t
      ),
    }));
  };

  const handlePauseSelected = () => {
    getEngine().pauseTracks(selectedIds);
    setSession((prev) => ({
      ...prev,
      tracks: prev.tracks.map((t) =>
        t.selected ? { ...t, status: "paused" as const } : t
      ),
    }));
  };

  const handleStopSelected = () => {
    getEngine().stopTracks(selectedIds);
    setSession((prev) => ({
      ...prev,
      tracks: prev.tracks.map((t) =>
        t.selected ? { ...t, status: "stopped" as const, playheadSec: 0 } : t
      ),
    }));
  };

  return (
    <div className="grid" style={{ gap: 16 }}>

      {/* ── 全域控制 ── */}
      <div className="card row" style={{ flexWrap: "wrap", gap: 16 }}>
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
        onPlaySelected={() => void handlePlaySelected()}
        onPauseSelected={handlePauseSelected}
        onStopSelected={handleStopSelected}
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
              onChange={(patch) => void updateTrack(track.id, patch)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
