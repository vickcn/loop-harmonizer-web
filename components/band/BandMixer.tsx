"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BandSession, BandSong, StemChannel } from "@/lib/band/bandTypes";
import { createDefaultBandSession } from "@/lib/band/bandSession";
import { createBandSong, getEffectivePlaybackRate, getSongPlaybackTrackIds, getStemAudibility } from "@/lib/band/songModel";
import { MultiTrackEngine } from "@/lib/band/multiTrackEngine";
import { DEMUCS_MODEL_VERSION, disposeStemSeparator, separateAudio } from "@/lib/separation/stemSeparator";
import type { SeparatedStemSet, StemSeparationMode } from "@/lib/separation/stemTypes";
import { encodeStereoWav } from "@/lib/separation/wavEncoder";
import { createSeparationCacheKey, SEPARATION_PROCESSING_VERSION } from "@/lib/storage/cacheKeys";
import { clearAllCachedStemSets, createStemCacheRecord, deleteCachedStemSet, getCachedStemBytes, getCachedStemSet, hashSourceAudio, putCachedStemSet } from "@/lib/storage/separationCache";
import { clearModelCache, getModelCacheMetadata } from "@/lib/storage/modelCache";
import { loadSongSettings, saveSongSettingsDebounced, type SavedSongSettings } from "@/lib/storage/songSettings";
import { SongCard } from "./SongCard";

type CacheStats = { stemBytes: number; modelBytes: number; usage: number | null; quota: number | null };

function clampBpm(value: number): number {
  return Math.max(20, Math.min(300, Math.round(value || 120)));
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "不支援";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function BandMixer() {
  const [session, setSession] = useState<BandSession>(createDefaultBandSession);
  const [loading, setLoading] = useState(false);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [cacheStats, setCacheStats] = useState<CacheStats>({ stemBytes: 0, modelBytes: 0, usage: null, quota: null });
  const sessionRef = useRef(session);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const engineRef = useRef<MultiTrackEngine | null>(null);
  const sourceFilesRef = useRef(new Map<string, File>());
  const stemResultsRef = useRef(new Map<string, SeparatedStemSet>());
  const separationTokensRef = useRef(new Map<string, symbol>());
  const savedSettingsRef = useRef(new Map<string, SavedSongSettings>());

  const getEngine = useCallback(() => {
    if (!engineRef.current) {
      const engine = new MultiTrackEngine();
      engine.onTrackEnded = (trackId) => {
        setSession((previous) => ({
          ...previous,
          songs: previous.songs.map((song) => getSongPlaybackTrackIds(song).includes(trackId)
            ? { ...song, status: "stopped", playheadSec: 0 }
            : song),
        }));
      };
      engineRef.current = engine;
    }
    return engineRef.current;
  }, []);

  const refreshCacheStats = useCallback(async () => {
    const estimatePromise = navigator.storage?.estimate
      ? navigator.storage.estimate().catch(() => null)
      : Promise.resolve(null);
    const [stemBytes, model, estimate] = await Promise.all([
      getCachedStemBytes().catch(() => 0),
      getModelCacheMetadata().catch(() => null),
      estimatePromise,
    ]);
    setCacheStats({ stemBytes, modelBytes: model?.sizeBytes ?? 0, usage: estimate?.usage ?? null, quota: estimate?.quota ?? null });
  }, []);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    void refreshCacheStats();
    return () => {
      engineRef.current?.dispose();
      engineRef.current = null;
      void disposeStemSeparator();
    };
  }, [refreshCacheStats]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const engine = engineRef.current;
      if (!engine) return;
      setSession((previous) => {
        let changed = false;
        const songs = previous.songs.map((song) => {
          if (song.status !== "playing") return song;
          const position = engine.getTrackPosition(getSongPlaybackTrackIds(song)[0]);
          if (Math.abs(position - song.playheadSec) < 0.03) return song;
          changed = true;
          return { ...song, playheadSec: position };
        });
        return changed ? { ...previous, songs } : previous;
      });
    }, 100);
    return () => window.clearInterval(timer);
  }, []);

  const applySongToEngine = useCallback((song: BandSong) => {
    const engine = getEngine();
    const allIds = [song.sourceAudioId, ...song.stemIds];
    const rate = getEffectivePlaybackRate(song);
    allIds.forEach((id) => {
      engine.setPlaybackRate(id, rate);
      engine.setPitchSemitones(id, song.keyShiftSemitones);
    });
    engine.setLoop(song.sourceAudioId, song.loop);
    engine.setLoopGroup(song.stemIds, song.loop);
    engine.setVolume(song.sourceAudioId, song.masterVolume);
    engine.setMuted(song.sourceAudioId, false);
    const audibility = getStemAudibility(song.stemChannels);
    song.stemChannels.forEach((channel) => {
      engine.setVolume(channel.id, song.masterVolume * channel.volume);
      engine.setMuted(channel.id, !audibility[channel.id]);
    });
  }, [getEngine]);

  const updateSong = useCallback((songId: string, patch: Partial<BandSong>) => {
    setSession((previous) => ({
      ...previous,
      songs: previous.songs.map((song) => {
        if (song.id !== songId) return song;
        const normalized: Partial<BandSong> = { ...patch };
        if ("originalBpm" in normalized) normalized.originalBpm = clampBpm(normalized.originalBpm ?? song.originalBpm);
        if ("targetBpm" in normalized) normalized.targetBpm = clampBpm(normalized.targetBpm ?? song.targetBpm);
        if ("keyShiftSemitones" in normalized) normalized.keyShiftSemitones = Math.max(-12, Math.min(12, Math.round(normalized.keyShiftSemitones ?? 0)));
        const next = { ...song, ...normalized };
        applySongToEngine(next);
        saveSongSettingsDebounced(next);
        return next;
      }),
    }));
  }, [applySongToEngine]);

  const handleFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setLoading(true);
    const engine = getEngine();
    for (const file of Array.from(files)) {
      const songId = `song_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const sourceAudioId = `${songId}_original`;
      try {
        const durationSec = await engine.loadTrack(sourceAudioId, file, "soundtouch");
        const settingsKey = `${file.name}:${file.size}:${file.lastModified}`;
        const saved = await loadSongSettings(settingsKey).catch(() => null);
        const baseSong = createBandSong({ id: songId, name: file.name.replace(/\.[^.]+$/, ""), fileName: file.name, sourceAudioId, settingsKey, originalBpm: 120, durationSec });
        const restoredRates = Array.isArray(saved?.savedRates)
          ? saved.savedRates.filter((value) => Number.isFinite(value) && value >= 0.25 && value <= 4)
          : [];
        const song: BandSong = saved ? {
          ...baseSong,
          targetBpm: clampBpm(saved.targetBpm),
          keyShiftSemitones: Math.max(-12, Math.min(12, saved.keyShiftSemitones)),
          masterVolume: Math.max(0, Math.min(1, saved.masterVolume)),
          tempoMode: saved.tempoMode,
          manualRate: Math.max(0.25, Math.min(4, saved.manualRate)),
          fineRateOffset: Math.max(-0.05, Math.min(0.05, saved.fineRateOffset)),
          savedRates: restoredRates.length ? restoredRates : [1],
          loop: saved.loop,
          separationMode: saved.separationMode ?? null,
        } : baseSong;
        if (saved) savedSettingsRef.current.set(songId, saved);
        sourceFilesRef.current.set(songId, file);
        applySongToEngine(song);
        setSession((previous) => ({ ...previous, songs: [...previous.songs, song] }));
        const restoreToken = Symbol(`restore_${songId}`);
        separationTokensRef.current.set(songId, restoreToken);
        window.setTimeout(() => void restoreCachedStems(song, file, restoreToken), 0);
      } catch {
        engine.removeTrack(sourceAudioId);
      }
    }
    setLoading(false);
  };

  const playSong = async (song: BandSong) => {
    applySongToEngine(song);
    await getEngine().playTracks(getSongPlaybackTrackIds(song));
    updateSong(song.id, { status: "playing" });
  };

  const pauseSong = (song: BandSong) => {
    getEngine().pauseTracks(getSongPlaybackTrackIds(song));
    updateSong(song.id, { status: "paused" });
  };

  const stopSong = (song: BandSong) => {
    getEngine().stopTracks([song.sourceAudioId, ...song.stemIds]);
    updateSong(song.id, { status: "stopped", playheadSec: 0 });
  };

  const seekSong = (song: BandSong, seconds: number) => {
    getEngine().seekTracks([song.sourceAudioId, ...song.stemIds], seconds);
    updateSong(song.id, { playheadSec: seconds });
  };

  const switchSource = async (song: BandSong, playbackSource: "original" | "stems") => {
    if (song.playbackSource === playbackSource || (playbackSource === "stems" && song.stemIds.length === 0)) return;
    const engine = getEngine();
    const oldIds = getSongPlaybackTrackIds(song);
    const nextSong = { ...song, playbackSource };
    const newIds = getSongPlaybackTrackIds(nextSong);
    engine.seekTracks(newIds, song.playheadSec);
    applySongToEngine(nextSong);
    if (song.status === "playing") {
      await engine.playTracks(newIds);
      engine.crossfadeTracks(oldIds, newIds);
    }
    setSession((previous) => ({
      ...previous,
      songs: previous.songs.map((candidate) => candidate.id === song.id ? nextSong : candidate),
    }));
    saveSongSettingsDebounced(nextSong);
  };

  const installStemSet = (song: BandSong, stems: SeparatedStemSet, cacheKey: string, message: string) => {
    const engine = getEngine();
    song.stemIds.forEach((id) => engine.removeTrack(id));
    const stemIds: string[] = [];
    const stemChannels: StemChannel[] = [];
    const saved = savedSettingsRef.current.get(song.id);
    for (const stem of stems.tracks) {
      const id = `${song.id}_stem_${stem.stemType}`;
      engine.loadStem(id, stem, stems.sampleRate);
      stemIds.push(id);
      const existingChannel = song.stemChannels.find((channel) => channel.stemType === stem.stemType);
      stemChannels.push({
        id,
        songId: song.id,
        stemType: stem.stemType,
        volume: existingChannel?.volume ?? saved?.stemVolumes?.[stem.stemType] ?? 1,
        muted: existingChannel?.muted ?? saved?.stemMuted?.[stem.stemType] ?? false,
        solo: existingChannel?.solo ?? saved?.stemSolo?.[stem.stemType] ?? false,
      });
    }
    stemResultsRef.current.set(song.id, stems);
    const nextSong: BandSong = { ...song, stemIds, stemChannels, separationStatus: "completed", separationMode: stems.mode, separationProgress: 1, separationMessage: message, playbackSource: "stems", cacheKey };
    engine.seekTracks(stemIds, song.playheadSec);
    applySongToEngine(nextSong);
    if (song.status === "playing") {
      void engine.playTracks(stemIds).then(() => {
        engine.crossfadeTracks([song.sourceAudioId], stemIds);
      });
    }
    setSession((previous) => ({ ...previous, songs: previous.songs.map((candidate) => candidate.id === song.id ? nextSong : candidate) }));
    saveSongSettingsDebounced(nextSong);
  };

  const restoreCachedStems = async (song: BandSong, file: File, token: symbol) => {
    try {
      const sourceAudioHash = await hashSourceAudio(file);
      const preferredMode = song.separationMode ?? "four_stem";
      const modes: StemSeparationMode[] = preferredMode === "four_stem"
        ? ["four_stem", "two_stem"]
        : ["two_stem", "four_stem"];
      for (const mode of modes) {
        const cacheKey = createSeparationCacheKey({
          sourceAudioHash,
          modelVersion: DEMUCS_MODEL_VERSION,
          separationMode: mode,
          processingVersion: SEPARATION_PROCESSING_VERSION,
        });
        const stems = await getCachedStemSet(cacheKey).catch(() => null);
        if (!stems) continue;
        if (separationTokensRef.current.get(song.id) !== token) return;
        const latestSong = sessionRef.current.songs.find((candidate) => candidate.id === song.id) ?? song;
        installStemSet(latestSong, stems, cacheKey, "已自動從本機快取恢復分離結果。");
        void refreshCacheStats();
        return;
      }
    } finally {
      if (separationTokensRef.current.get(song.id) === token) separationTokensRef.current.delete(song.id);
    }
  };

  const separateSong = async (song: BandSong, mode: StemSeparationMode) => {
    const file = sourceFilesRef.current.get(song.id);
    if (!file) {
      updateSong(song.id, { separationStatus: "failed", separationMessage: "原始音訊已不在記憶體，請重新載入歌曲。" });
      return;
    }
    const token = Symbol(song.id);
    separationTokensRef.current.set(song.id, token);
    updateSong(song.id, { separationStatus: "processing", separationMode: mode, separationProgress: 0, separationMessage: "正在計算歌曲指紋…" });
    try {
      const sourceAudioHash = await hashSourceAudio(file);
      const cacheKey = createSeparationCacheKey({ sourceAudioHash, modelVersion: DEMUCS_MODEL_VERSION, separationMode: mode, processingVersion: SEPARATION_PROCESSING_VERSION });
      let stems = await getCachedStemSet(cacheKey).catch(() => null);
      let message = "已從本機快取載入分離結果。";
      if (!stems) {
        const result = await separateAudio(file, {
          mode,
          onStatus: (separationMessage) => updateSong(song.id, { separationMessage }),
          onDownloadProgress: (progress) => updateSong(song.id, { separationMessage: `模型下載 ${Math.round(progress * 100)}%` }),
          onProgress: (progress, current, total) => updateSong(song.id, { separationProgress: progress, separationMessage: `分離片段 ${current}/${total}` }),
        });
        stems = result.stems;
        message = `分離完成（${result.backend === "webgpu" ? "WebGPU" : "WASM"}）。`;
        try {
          await putCachedStemSet(createStemCacheRecord({ key: cacheKey, sourceAudioHash, modelVersion: DEMUCS_MODEL_VERSION, processingVersion: SEPARATION_PROCESSING_VERSION, stems }));
        } catch (cacheError) {
          message += ` ${cacheError instanceof Error ? cacheError.message : "結果無法持久快取。"}`;
        }
      }
      if (separationTokensRef.current.get(song.id) !== token) return;
      const latestSong = sessionRef.current.songs.find((candidate) => candidate.id === song.id);
      if (!latestSong) return;
      installStemSet(latestSong, stems, cacheKey, message);
      void refreshCacheStats();
    } catch (error) {
      if (separationTokensRef.current.get(song.id) !== token) return;
      updateSong(song.id, { separationStatus: "failed", separationMessage: error instanceof Error ? error.message : "音源分離失敗。" });
    } finally {
      if (separationTokensRef.current.get(song.id) === token) separationTokensRef.current.delete(song.id);
    }
  };

  const updateStem = (song: BandSong, stemId: string, patch: Partial<StemChannel>) => {
    updateSong(song.id, { stemChannels: song.stemChannels.map((channel) => channel.id === stemId ? { ...channel, ...patch } : channel) });
  };

  const downloadStem = (song: BandSong, stemId: string) => {
    const stems = stemResultsRef.current.get(song.id);
    const channel = song.stemChannels.find((item) => item.id === stemId);
    const stem = stems?.tracks.find((item) => item.stemType === channel?.stemType);
    if (!stem || !stems) return;
    const blob = new Blob([encodeStereoWav(stem.left, stem.right, stems.sampleRate)], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${song.name.replace(/[^\p{L}\p{N}_-]+/gu, "-")}-${stem.stemType}.wav`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const clearSongCache = async (song: BandSong) => {
    if (song.cacheKey) await deleteCachedStemSet(song.cacheKey).catch(() => undefined);
    updateSong(song.id, { cacheKey: null, separationMessage: "已清除持久快取；目前載入的分軌仍可播放。" });
    void refreshCacheStats();
  };

  const clearAllSeparationCache = async () => {
    await clearAllCachedStemSets().catch(() => undefined);
    setSession((previous) => ({
      ...previous,
      songs: previous.songs.map((song) => ({
        ...song,
        cacheKey: null,
        separationMessage: song.stemIds.length
          ? "已清除持久快取；目前載入的分軌仍可播放。"
          : song.separationMessage,
      })),
    }));
    void refreshCacheStats();
  };

  const removeSong = (song: BandSong) => {
    separationTokensRef.current.delete(song.id);
    const ids = [song.sourceAudioId, ...song.stemIds];
    getEngine().stopTracks(ids);
    ids.forEach((id) => getEngine().removeTrack(id));
    sourceFilesRef.current.delete(song.id);
    stemResultsRef.current.delete(song.id);
    savedSettingsRef.current.delete(song.id);
    setSession((previous) => ({ ...previous, songs: previous.songs.filter((candidate) => candidate.id !== song.id) }));
  };

  const moveSong = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    setSession((previous) => {
      const songs = [...previous.songs];
      const from = songs.findIndex((song) => song.id === fromId);
      const to = songs.findIndex((song) => song.id === toId);
      if (from < 0 || to < 0) return previous;
      const [song] = songs.splice(from, 1);
      songs.splice(to, 0, song);
      return { ...previous, songs };
    });
  };

  const selectedSongs = session.songs.filter((song) => song.selected);

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card row" style={{ gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <button className="btn primary" disabled={loading} onClick={() => fileInputRef.current?.click()}>{loading ? "載入中…" : "＋ 載入歌曲"}</button>
        <input ref={fileInputRef} type="file" accept="audio/*" multiple hidden onChange={(event) => { void handleFiles(event.target.files); event.target.value = ""; }} />
        <span className="small" style={{ opacity: 0.65 }}>音訊、分離、變速與變 Key 全部在瀏覽器執行，不經 Vercel 音訊 API。</span>
      </div>

      <div className="card row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <strong>歌曲多選播放控制</strong>
        <span className="small" style={{ opacity: selectedSongs.length ? 0.8 : 0.4 }}>已選 {selectedSongs.length} 首</span>
        <button className="btn primary" disabled={!selectedSongs.length} onClick={() => void Promise.all(selectedSongs.map(playSong))}>▶ 播放所選</button>
        <button className="btn" disabled={!selectedSongs.length} onClick={() => selectedSongs.forEach(pauseSong)}>⏸ 暫停所選</button>
        <button className="btn" disabled={!selectedSongs.length} onClick={() => selectedSongs.forEach(stopSong)}>■ 停止所選</button>
      </div>

      <details className="card">
        <summary style={{ cursor: "pointer", fontWeight: 700 }}>本機音訊快取管理</summary>
        <div className="row" style={{ gap: 12, flexWrap: "wrap", marginTop: 12 }}>
          <span className="small">分離結果：{formatBytes(cacheStats.stemBytes)}</span>
          <span className="small">模型：{formatBytes(cacheStats.modelBytes)}</span>
          <span className="small">瀏覽器用量：{formatBytes(cacheStats.usage)} / {formatBytes(cacheStats.quota)}</span>
          <button className="btn" onClick={() => void clearAllSeparationCache()}>清理所有分離結果</button>
          <button className="btn" onClick={() => void clearModelCache().then(refreshCacheStats)}>清理模型快取</button>
          <button className="btn" onClick={() => void refreshCacheStats()}>重新整理容量</button>
        </div>
        <p className="small" style={{ opacity: 0.6, marginBottom: 0 }}>清理快取不會移除已載入的原始歌曲，也不會中斷目前記憶體中的播放資料。</p>
      </details>

      {session.songs.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: "48px 16px" }}>
          <p className="small" style={{ opacity: 0.5, margin: 0 }}>尚未載入歌曲</p>
          <p className="small" style={{ opacity: 0.35, marginTop: 6 }}>載入後可直接在歌曲卡片內分離音源</p>
        </div>
      ) : (
        <div className="grid" style={{ gap: 12 }}>
          {session.songs.map((song) => (
            <div key={song.id} draggable onDragStart={() => setDraggingId(song.id)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (draggingId) moveSong(draggingId, song.id); setDraggingId(null); }} onDragEnd={() => setDraggingId(null)} style={{ opacity: draggingId === song.id ? 0.45 : 1 }}>
              <SongCard
                song={song}
                collapsed={collapsedIds.has(song.id)}
                onToggleCollapse={() => setCollapsedIds((previous) => { const next = new Set(previous); next.has(song.id) ? next.delete(song.id) : next.add(song.id); return next; })}
                onChange={(patch) => updateSong(song.id, patch)}
                onPlayPause={() => song.status === "playing" ? pauseSong(song) : void playSong(song)}
                onStop={() => stopSong(song)}
                onSeek={(seconds) => seekSong(song, seconds)}
                onSeparate={(mode) => void separateSong(song, mode)}
                onSwitchSource={(source) => void switchSource(song, source)}
                onStemChange={(id, patch) => updateStem(song, id, patch)}
                onDownloadStem={(id) => downloadStem(song, id)}
                onClearSongCache={() => void clearSongCache(song)}
                onRemove={() => removeSong(song)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
