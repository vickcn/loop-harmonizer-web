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
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const engineRef = useRef<MultiTrackEngine | null>(null);

  const toggleCollapse = (id: string) =>
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const moveTrack = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    setSession((prev) => {
      const tracks = [...prev.tracks];
      const fromIdx = tracks.findIndex((t) => t.id === fromId);
      const toIdx = tracks.findIndex((t) => t.id === toId);
      if (fromIdx === -1 || toIdx === -1) return prev;
      const [item] = tracks.splice(fromIdx, 1);
      tracks.splice(toIdx, 0, item);
      return { ...prev, tracks };
    });
  };

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
          syncMode: "manual-rate",
          loop: false,
          playbackMode: "fast-rate",
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

    setSession((prev) => {
      const track = prev.tracks.find((t) => t.id === id);
      if (!track) return prev;

      let resolved = { ...patch };

      // syncMode switching: recalculate baseRate for global-bpm
      if ("syncMode" in resolved && resolved.syncMode === "global-bpm") {
        const obpm = ("originalBpm" in resolved ? resolved.originalBpm : track.originalBpm) ?? track.originalBpm;
        resolved.baseRate = Math.max(0.25, Math.min(4, prev.globalBpm / obpm));
      }

      // originalBpm change while in global-bpm mode: recalculate baseRate
      if ("originalBpm" in resolved && !("syncMode" in resolved) && track.syncMode === "global-bpm") {
        resolved.baseRate = Math.max(0.25, Math.min(4, prev.globalBpm / (resolved.originalBpm ?? track.originalBpm)));
      }

      const updated = { ...track, ...resolved };

      // push to engine (must be synchronous sub-calls, no await inside setSession)
      void (async () => {
        if ("status" in resolved) {
          if (resolved.status === "playing") await eng.playTrack(id);
          else if (resolved.status === "paused") eng.pauseTrack(id);
          else if (resolved.status === "stopped") eng.stopTrack(id);
        }
        if ("playheadSec" in resolved && !("status" in resolved)) {
          await eng.seekTrack(id, resolved.playheadSec!);
        }
        if ("volume" in resolved) eng.setVolume(id, resolved.volume!);
        if ("muted" in resolved) eng.setMuted(id, resolved.muted!);
        if ("loop" in resolved) eng.setLoop(id, resolved.loop!);
        if ("baseRate" in resolved) eng.setPlaybackRate(id, resolved.baseRate!);
        if ("playbackMode" in resolved) eng.setPlaybackMode(id, resolved.playbackMode!);
      })();

      return {
        ...prev,
        tracks: prev.tracks.map((t) => (t.id === id ? updated : t)),
      };
    });
  };

  // Global BPM change: recalculate baseRate for all global-bpm tracks
  const handleGlobalBpm = (newBpm: number) => {
    const eng = getEngine();
    setSession((prev) => {
      const tracks = prev.tracks.map((t) => {
        if (t.syncMode !== "global-bpm") return t;
        const baseRate = Math.max(0.25, Math.min(4, newBpm / t.originalBpm));
        eng.setPlaybackRate(t.id, baseRate);
        return { ...t, baseRate };
      });
      return { ...prev, globalBpm: newBpm, tracks };
    });
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
      <div className="card row" style={{ flexWrap: "wrap", gap: 16, alignItems: "center" }}>
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

        {/* 輔助 BPM */}
        <div className="row" style={{ gap: 6, alignItems: "center", marginLeft: "auto" }}>
          <span className="small" style={{ opacity: 0.6 }}>輔助 BPM</span>
          <button
            className="btn"
            style={{ padding: "3px 8px", fontWeight: 700 }}
            onClick={() => handleGlobalBpm(Math.max(20, session.globalBpm - 1))}
          >−</button>
          <input
            className="input"
            type="number"
            min={20} max={300} step={1}
            value={session.globalBpm}
            style={{ width: 64, fontWeight: 700, fontSize: 16, textAlign: "center", padding: "4px 6px" }}
            onChange={(e) => {
              const v = Math.max(20, Math.min(300, Number(e.target.value) || 120));
              handleGlobalBpm(v);
            }}
          />
          <button
            className="btn"
            style={{ padding: "3px 8px", fontWeight: 700 }}
            onClick={() => handleGlobalBpm(Math.min(300, session.globalBpm + 1))}
          >+</button>
        </div>
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
            <div
              key={track.id}
              draggable
              onDragStart={() => setDraggingId(track.id)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); if (draggingId) moveTrack(draggingId, track.id); setDraggingId(null); }}
              onDragEnd={() => setDraggingId(null)}
              style={{ opacity: draggingId === track.id ? 0.45 : 1, transition: "opacity .15s" }}
            >
              <TrackCard
                track={track}
                onChange={(patch) => void updateTrack(track.id, patch)}
                collapsed={collapsedIds.has(track.id)}
                onToggleCollapse={() => toggleCollapse(track.id)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
