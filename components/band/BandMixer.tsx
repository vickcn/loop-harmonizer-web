"use client";

import { useEffect, useRef, useState } from "react";
import { BandSession, BandTrack, TrackSyncMode } from "@/lib/band/bandTypes";
import { createDefaultBandSession } from "@/lib/band/bandSession";
import { calculateGlobalPlaybackRate, normalizeKeyShift } from "@/lib/band/globalPlaybackControls";
import { MultiTrackEngine } from "@/lib/band/multiTrackEngine";
import { getLinkedStemTrackIds } from "@/lib/band/stemSync";
import { createStemTrackDescriptors } from "@/lib/separation/stemTypes";
import { disposeStemSeparator, type StemSeparationResult } from "@/lib/separation/stemSeparator";
import { TrackCard } from "./TrackCard";
import { SelectedTracksBar } from "./SelectedTracksBar";
import { StemSeparationDialog } from "./StemSeparationDialog";

export function BandMixer() {
  const [session, setSession] = useState<BandSession>(createDefaultBandSession);
  const [loading, setLoading] = useState(false);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [separatorOpen, setSeparatorOpen] = useState(false);
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
      void disposeStemSeparator();
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
          coarseRate: 1.0,
          baseRate: 1.0,
          savedRates: [1.0],
          volume: 1.0,
          muted: false,
          selected: false,
          playheadSec: 0,
          durationSec,
          status: "stopped",
          syncMode: "manual-rate",
          loop: false,
          playbackMode: "pitch-preserve",
          keyShiftSemitones: 0,
          followsGlobalKey: false,
        };
        setSession((prev) => ({ ...prev, tracks: [...prev.tracks, track] }));
      } catch {
        // unsupported format — skip silently
      }
    }
    setLoading(false);
  };

  const handleAddSeparatedStems = async (result: StemSeparationResult, sourceFileName: string) => {
    const eng = getEngine();
    const sourceGroupId = `stem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const descriptors = createStemTrackDescriptors(
      result.stems,
      sourceFileName,
      sourceGroupId,
      (stemType) => `track_${Date.now()}_${stemType}_${Math.random().toString(36).slice(2, 6)}`,
    );
    const loadedIds: string[] = [];

    try {
      const tracks = descriptors.map((descriptor, index) => {
        const durationSec = eng.loadStem(
          descriptor.id,
          result.stems.tracks[index],
          result.stems.sampleRate,
        );
        loadedIds.push(descriptor.id);
        return { ...descriptor, durationSec } satisfies BandTrack;
      });
      setSession((prev) => ({ ...prev, tracks: [...prev.tracks, ...tracks] }));
    } catch (error) {
      loadedIds.forEach((id) => eng.removeTrack(id));
      throw error;
    }
  };

  // Per-track change handler — intercepts engine-relevant fields
  const updateTrack = async (id: string, patch: Partial<BandTrack>) => {
    const eng = getEngine();

    setSession((prev) => {
      const track = prev.tracks.find((t) => t.id === id);
      if (!track) return prev;

      let resolved = { ...patch };

      // syncMode switching: recalculate coarseRate/baseRate for global-bpm (fine offset resets)
      if ("syncMode" in resolved && resolved.syncMode === "global-bpm") {
        const obpm = ("originalBpm" in resolved ? resolved.originalBpm : track.originalBpm) ?? track.originalBpm;
        const r = Math.max(0.25, Math.min(4, prev.globalBpm / obpm));
        resolved.coarseRate = r;
        resolved.baseRate = r;
      }

      // originalBpm change while in global-bpm mode: recalculate (fine offset resets)
      if ("originalBpm" in resolved && !("syncMode" in resolved) && track.syncMode === "global-bpm") {
        const r = Math.max(0.25, Math.min(4, prev.globalBpm / (resolved.originalBpm ?? track.originalBpm)));
        resolved.coarseRate = r;
        resolved.baseRate = r;
      }

      // coarseRate change (from UI coarse controls): reset fine offset
      if ("coarseRate" in resolved && !("baseRate" in resolved)) {
        resolved.baseRate = resolved.coarseRate!;
      }

      const updated = { ...track, ...resolved };
      const shouldSyncTempo = Boolean(track.stemMetadata) && (
        "originalBpm" in resolved || "coarseRate" in resolved || "baseRate" in resolved || "syncMode" in resolved
      );
      const shouldSyncPlayhead = "playheadSec" in resolved && !("status" in resolved) && Boolean(track.stemMetadata);
      const shouldSyncLoop = "loop" in resolved && Boolean(track.stemMetadata);
      const linkedTrackIds = shouldSyncTempo || shouldSyncPlayhead || shouldSyncLoop
        ? getLinkedStemTrackIds(prev.tracks, id)
        : [id];

      // push to engine (must be synchronous sub-calls, no await inside setSession)
      void (async () => {
        if ("status" in resolved) {
          if (resolved.status === "playing") await eng.playTrack(id);
          else if (resolved.status === "paused") eng.pauseTrack(id);
          else if (resolved.status === "stopped") eng.stopTrack(id);
        }
        if ("playheadSec" in resolved && !("status" in resolved)) {
          if (shouldSyncPlayhead) eng.seekTracks(linkedTrackIds, resolved.playheadSec!);
          else await eng.seekTrack(id, resolved.playheadSec!);
        }
        if ("volume" in resolved) eng.setVolume(id, resolved.volume!);
        if ("muted" in resolved) eng.setMuted(id, resolved.muted!);
        if ("loop" in resolved) {
          linkedTrackIds.forEach((trackId) => eng.setLoop(trackId, resolved.loop!));
        }
        if ("baseRate" in resolved) {
          if (shouldSyncTempo) linkedTrackIds.forEach((trackId) => eng.setPlaybackRate(trackId, resolved.baseRate!));
          else eng.setPlaybackRate(id, resolved.baseRate!);
        }
        if ("keyShiftSemitones" in resolved) eng.setPitchSemitones(id, resolved.keyShiftSemitones!);
        if ("playbackMode" in resolved) eng.setPlaybackMode(id, resolved.playbackMode!);
      })();

      return {
        ...prev,
        tracks: prev.tracks.map((t) => {
          if (t.id === id) return updated;
          if (!linkedTrackIds.includes(t.id)) return t;
          return {
            ...t,
            ...(shouldSyncTempo && "originalBpm" in resolved ? { originalBpm: resolved.originalBpm! } : {}),
            ...(shouldSyncTempo && "coarseRate" in resolved ? { coarseRate: resolved.coarseRate! } : {}),
            ...(shouldSyncTempo && "baseRate" in resolved ? { baseRate: resolved.baseRate! } : {}),
            ...(shouldSyncTempo && "syncMode" in resolved ? { syncMode: resolved.syncMode! } : {}),
            ...(shouldSyncPlayhead ? { playheadSec: resolved.playheadSec! } : {}),
            ...(shouldSyncLoop ? { loop: resolved.loop! } : {}),
          };
        }),
      };
    });
  };

  // Global BPM change: recalculate coarseRate/baseRate for all global-bpm tracks (fine offset resets)
  const handleGlobalBpm = (newBpm: number) => {
    const eng = getEngine();
    setSession((prev) => {
      const tracks = prev.tracks.map((t) => {
        if (t.syncMode !== "global-bpm") return t;
        const r = calculateGlobalPlaybackRate(newBpm, t.originalBpm);
        eng.setPlaybackRate(t.id, r);
        return { ...t, coarseRate: r, baseRate: r };
      });
      return { ...prev, globalBpm: newBpm, tracks };
    });
  };

  const handleGlobalKeyShift = (semitones: number) => {
    const nextSemitones = normalizeKeyShift(semitones);
    const eng = getEngine();
    setSession((prev) => {
      const tracks = prev.tracks.map((track) => {
        if (!track.followsGlobalKey) return track;
        eng.setPitchSemitones(track.id, nextSemitones);
        return { ...track, keyShiftSemitones: nextSemitones };
      });
      return { ...prev, globalKeyShiftSemitones: nextSemitones, tracks };
    });
  };

  const resetGlobalBpm = () => {
    const eng = getEngine();
    setSession((prev) => ({
      ...prev,
      globalBpm: 120,
      tracks: prev.tracks.map((track) => {
        if (track.syncMode !== "global-bpm") return track;
        eng.setPlaybackRate(track.id, 1, 0);
        return { ...track, coarseRate: 1, baseRate: 1 };
      }),
    }));
  };

  const resetGlobalKey = () => handleGlobalKeyShift(0);

  const selectedIds = session.tracks.filter((t) => t.selected).map((t) => t.id);
  const globalRate = session.tracks.find((track) => track.followsGlobalKey)?.baseRate
    ?? calculateGlobalPlaybackRate(session.globalBpm, 120);

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
        <button className="btn" disabled={loading} onClick={() => setSeparatorOpen(true)}>
          ✦ 分離音源
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*"
          multiple
          style={{ display: "none" }}
          onChange={(e) => { void handleFiles(e.target.files); e.target.value = ""; }}
        />

        <div className="row" style={{ gap: 12, alignItems: "center", marginLeft: "auto" }}>
          <div className="row" style={{ gap: 6, alignItems: "center" }}>
            <span className="small" style={{ opacity: 0.6 }}>全域 BPM</span>
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
              onChange={(e) => handleGlobalBpm(Math.max(20, Math.min(300, Number(e.target.value) || 120)))}
            />
            <button
              className="btn"
              style={{ padding: "3px 8px", fontWeight: 700 }}
              onClick={() => handleGlobalBpm(Math.min(300, session.globalBpm + 1))}
            >+</button>
            <button className="btn" style={{ padding: "4px 8px", fontSize: 12 }} onClick={resetGlobalBpm}>↺ 原始 BPM</button>
          </div>

          <div className="row" style={{ gap: 6, alignItems: "center" }}>
            <span className="small" style={{ opacity: 0.6 }}>全域 Key</span>
            <button className="btn" style={{ padding: "3px 8px", fontWeight: 700 }} onClick={() => handleGlobalKeyShift(session.globalKeyShiftSemitones - 1)}>−</button>
            <input
              className="input"
              type="number"
              min={-12} max={12} step={1}
              value={session.globalKeyShiftSemitones}
              aria-label="全域升降 Key 半音"
              style={{ width: 56, fontWeight: 700, fontSize: 16, textAlign: "center", padding: "4px 6px" }}
              onChange={(e) => handleGlobalKeyShift(Number(e.target.value))}
            />
            <span className="small">半音</span>
            <button className="btn" style={{ padding: "3px 8px", fontWeight: 700 }} onClick={() => handleGlobalKeyShift(session.globalKeyShiftSemitones + 1)}>+</button>
            <button className="btn" style={{ padding: "4px 8px", fontSize: 12 }} onClick={resetGlobalKey}>↺ 原始 Key</button>
          </div>

          <span className="small" style={{ opacity: 0.7, fontVariantNumeric: "tabular-nums" }}>
            目前：{globalRate.toFixed(3)}× · {session.globalKeyShiftSemitones >= 0 ? "+" : ""}{session.globalKeyShiftSemitones} 半音
          </span>
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

      <StemSeparationDialog
        open={separatorOpen}
        onClose={() => setSeparatorOpen(false)}
        onAddStems={handleAddSeparatedStems}
      />
    </div>
  );
}
