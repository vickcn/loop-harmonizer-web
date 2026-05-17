"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FileLoader } from "@/components/FileLoader";
import { LiveBeatPanel } from "@/components/LiveBeatPanel";
import { MetronomePanel } from "@/components/MetronomePanel";
import { TapTempoPad } from "@/components/TapTempoPad";
import { TimelineEditor } from "@/components/TimelineEditor";
import { TransportBar } from "@/components/TransportBar";
import { BrowserLoopEngine, DriverMode, EngineStatus, PlaybackMode } from "@/lib/audioEngine";
import { getSectionAtBar } from "@/lib/timeline";
import {
  DEFAULT_SOUND_ID,
  findSound,
  getAllSounds,
  loadCustomSounds,
  MetronomeSound,
  saveCustomSounds,
} from "@/lib/metronome/metronomeSound";
import { defaultTimeline } from "@/lib/timeline";
import { AudioSourceMeta, SongTimeline } from "@/lib/types";

export default function Page() {
  const [timeline, setTimeline] = useState<SongTimeline>(defaultTimeline);
  const [loaded, setLoaded] = useState(false);
  const [targetBpm, setTargetBpm] = useState(132);
  const [transitionBeats, setTransitionBeats] = useState(8);
  const [metronomeEnabled, setMetronomeEnabled] = useState(false);
  const [metronomeAccent, setMetronomeAccent] = useState(true);
  const [metronomeVolume, setMetronomeVolume] = useState(0.8);
  const [audioVolume, setAudioVolume] = useState(1.0);
  const [customSounds, setCustomSounds] = useState<MetronomeSound[]>(() => loadCustomSounds());
  const [currentSoundId, setCurrentSoundId] = useState(DEFAULT_SOUND_ID);
  const [status, setStatus] = useState<EngineStatus>({
    isPlaying: false,
    isMetronomeOnly: false,
    currentBar: 1,
    currentBpm: defaultTimeline.projectBpm,
    timelineBpm: defaultTimeline.projectBpm,
    actualBpm: defaultTimeline.projectBpm,
    tempoRatio: 1,
    playbackMode: "pitch-preserve",
    pitchPreserveReady: false,
    driverMode: "loop",
    loopBpm: defaultTimeline.projectBpm,
  });

  const engineRef = useRef<BrowserLoopEngine | null>(null);

  // Section loop: null = off, string = target section id
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  // pending = waiting for current section to end before jumping
  const activeSectionIdRef = useRef<string | null>(null);
  const pendingSectionIdRef = useRef<string | null>(null);
  const prevBarRef = useRef(1);

  const engine = useMemo(() => {
    if (!engineRef.current) {
      engineRef.current = new BrowserLoopEngine(defaultTimeline);
      engineRef.current.setStatusCallback(setStatus);
    }
    return engineRef.current;
  }, []);

  const updateTimeline = (next: SongTimeline) => {
    setTimeline(next);
    engine.setTimeline(next);
  };

  // Section loop boundary detection
  useEffect(() => {
    if (!status.isPlaying) return;
    const currentBar = status.currentBar;
    const prevBar = prevBarRef.current;
    prevBarRef.current = currentBar;

    const activeId = activeSectionIdRef.current;
    const pendingId = pendingSectionIdRef.current;

    if (activeId) {
      const sec = timeline.sections.find((s) => s.id === activeId);
      if (sec && (currentBar > sec.endBar || currentBar < sec.startBar)) {
        void engine.seekToBar(sec.startBar);
      }
      return;
    }

    if (pendingId) {
      const originSec = getSectionAtBar(timeline, prevBar);
      if (!originSec || currentBar > originSec.endBar || currentBar < originSec.startBar) {
        const target = timeline.sections.find((s) => s.id === pendingId);
        if (target) {
          pendingSectionIdRef.current = null;
          activeSectionIdRef.current = pendingId;
          setActiveSectionId(pendingId);
          void engine.seekToBar(target.startBar);
        }
      }
    }
  }, [status.currentBar, status.isPlaying, timeline, engine]);

  const handleSectionClick = (sectionId: string) => {
    const section = timeline.sections.find((s) => s.id === sectionId);
    if (!section) return;

    if (sectionId === activeSectionIdRef.current) {
      // Click active section again → cancel loop
      activeSectionIdRef.current = null;
      pendingSectionIdRef.current = null;
      setActiveSectionId(null);
      return;
    }

    if (!status.isPlaying) {
      void engine.seekToBar(section.startBar);
      return;
    }

    const currentSec = getSectionAtBar(timeline, status.currentBar);
    if (!currentSec || currentSec.id === sectionId) {
      // Already in target or in gap → activate immediately
      activeSectionIdRef.current = sectionId;
      pendingSectionIdRef.current = null;
      setActiveSectionId(sectionId);
      void engine.seekToBar(section.startBar);
    } else {
      // Queue: wait for current section to end
      pendingSectionIdRef.current = sectionId;
      activeSectionIdRef.current = null;
      setActiveSectionId(sectionId); // visual highlight while pending too
    }
  };

  const handleFileConfirmed = async (file: File, audioOriginalBpm: number) => {
    const audioSource: AudioSourceMeta = {
      id: `audio_${Date.now()}`,
      fileName: file.name,
      userConfirmedBpm: audioOriginalBpm,
    };
    const nextTimeline: SongTimeline = {
      ...timeline,
      projectBpm: audioOriginalBpm,
      audioSource,
      tempoAnchors: timeline.tempoAnchors.map((a) => ({ ...a, bpm: audioOriginalBpm })),
    };
    updateTimeline(nextTimeline);
    setTargetBpm(audioOriginalBpm);

    await engine.loadFile(file);
    setLoaded(true);

    const duration = engine.getBufferDuration();
    if (duration) {
      const bpb = nextTimeline.timeSignature.beatsPerBar;
      const totalBars = Math.max(4, Math.round(duration * audioOriginalBpm / 60 / bpb));
      updateTimeline({ ...nextTimeline, totalBars });
    }
  };

  const playAs = (mode: DriverMode) => {
    engine.setDriverMode(mode);
    void engine.play();
  };

  const clearSectionLoop = () => {
    activeSectionIdRef.current = null;
    pendingSectionIdRef.current = null;
    setActiveSectionId(null);
  };

  const handleMetronomeEnabled = (v: boolean) => { setMetronomeEnabled(v); engine.setMetronomeEnabled(v); };
  const handleMetronomeAccent = (v: boolean) => { setMetronomeAccent(v); engine.setMetronomeAccent(v); };
  const handleMetronomeVolume = (v: number) => { setMetronomeVolume(v); engine.setMetronomeVolume(v); };
  const handleAudioVolume = (v: number) => { setAudioVolume(v); engine.setAudioVolume(v); };

  const allSounds = getAllSounds(customSounds);

  const handleSoundChange = (id: string) => {
    setCurrentSoundId(id);
    engine.setMetronomeSound(findSound(allSounds, id));
  };

  const handleCustomSoundsChange = (next: MetronomeSound[]) => {
    setCustomSounds(next);
    saveCustomSounds(next);
  };

  const handlePreviewSound = (sound: MetronomeSound) => {
    engine.previewClick(sound);
  };

  const triggerLiveBeat = (bpm = targetBpm, beats = transitionBeats, isDirect = false) => {
    setTargetBpm(bpm);
    setTransitionBeats(beats);
    engine.triggerLiveBeatChange(bpm, beats, isDirect);
  };

  const handlePlayheadChange = (bar: number) => {
    void engine.seekToBar(bar);
  };

  const loopIsPlaying = status.isPlaying && status.driverMode === "loop";
  const timelineIsPlaying = status.isPlaying && status.driverMode === "timeline";

  return (
    <main className="container layout">
      {/* ── Header ── */}
      <header className="col-full">
        <h1 className="title">Loop Harmonizer M3 Web</h1>
        <p className="subtitle">流程播放、段落時間軸、Tempo 錨點、同步節拍器、即時切 beat 線性緩衝、Tap Tempo + Vercel API，並加入免費 WSOLA-inspired 保音高變速原型。</p>
      </header>

      {/* ── Loop Transport ── */}
      <div className="col-full">
        <TransportBar
          title="Loop 播放"
          loaded={loaded}
          isActive={status.driverMode === "loop"}
          isPlaying={loopIsPlaying}
          currentBar={status.currentBar}
          currentBpm={status.currentBpm}
          timelineBpm={status.loopBpm}
          tempoRatio={status.tempoRatio}
          playbackMode={status.playbackMode}
          pitchPreserveReady={status.pitchPreserveReady}
          showModeSelector={true}
          onPlaybackModeChange={(mode: PlaybackMode) => void engine.setPlaybackMode(mode)}
          onPlay={() => playAs("loop")}
          onPause={() => engine.pause()}
          onStop={() => { engine.stop(); clearSectionLoop(); }}
        />
      </div>

      {/* ── 節拍器 全幅 ── */}
      <div className="col-full">
        <MetronomePanel
          enabled={metronomeEnabled}
          accentFirstBeat={metronomeAccent}
          metronomeVolume={metronomeVolume}
          audioVolume={audioVolume}
          standaloneIsPlaying={status.isPlaying && status.isMetronomeOnly}
          onStandalonePlay={() => { engine.setDriverMode("loop"); void engine.play(); }}
          onStandaloneStop={() => engine.stop()}
          onEnabledChange={handleMetronomeEnabled}
          onAccentChange={handleMetronomeAccent}
          onMetronomeVolumeChange={handleMetronomeVolume}
          onAudioVolumeChange={handleAudioVolume}
          sounds={allSounds}
          currentSoundId={currentSoundId}
          onSoundChange={handleSoundChange}
          onCustomSoundsChange={handleCustomSoundsChange}
          onPreviewSound={handlePreviewSound}
        />
      </div>

      {/* ── 即時切 Beat (6) + Tap Tempo (6) ── */}
      <div className="col-6">
        <LiveBeatPanel
          targetBpm={targetBpm}
          transitionBeats={transitionBeats}
          canSaveAsAudioBase={loaded}
          onTargetBpmChange={setTargetBpm}
          onTransitionBeatsChange={setTransitionBeats}
          onApply={() => triggerLiveBeat()}
          onApplyDirect={() => triggerLiveBeat(targetBpm, transitionBeats, true)}
          onSaveAsAudioBase={() => {
            updateTimeline({ ...timeline, audioSource: { ...timeline.audioSource, userConfirmedBpm: targetBpm } });
          }}
          onApplyPreset={(bpm) => triggerLiveBeat(bpm, transitionBeats, false)}
          onApplyDirectPreset={(bpm) => triggerLiveBeat(bpm, transitionBeats, true)}
        />
      </div>
      <div className="col-6">
        <TapTempoPad
          songId={timeline.id}
          currentTimelineBpm={status.loopBpm}
          onSuggestedBpm={(bpm, beats) => {
            setTargetBpm(bpm);
            setTransitionBeats(beats);
          }}
        />
      </div>

      {/* ── Loop 載入 ── */}
      <div className="col-4">
        <FileLoader
          audioSource={timeline.audioSource}
          onFileConfirmed={handleFileConfirmed}
          onAudioBpmChange={(bpm) => {
            updateTimeline({
              ...timeline,
              audioSource: { ...timeline.audioSource, userConfirmedBpm: bpm },
              tempoAnchors: timeline.tempoAnchors.map((a) => ({ ...a, bpm })),
            });
            setTargetBpm(bpm);
          }}
        />
      </div>

      {/* ── Timeline Transport ── */}
      <div className="col-full">
        <TransportBar
          title="Timeline 播放"
          loaded={loaded}
          isActive={status.driverMode === "timeline"}
          isPlaying={timelineIsPlaying}
          currentBar={status.currentBar}
          currentBpm={status.currentBpm}
          timelineBpm={status.timelineBpm}
          tempoRatio={status.tempoRatio}
          playbackMode={status.playbackMode}
          pitchPreserveReady={status.pitchPreserveReady}
          showModeSelector={false}
          onPlaybackModeChange={(mode: PlaybackMode) => void engine.setPlaybackMode(mode)}
          onPlay={() => playAs("timeline")}
          onPause={() => engine.pause()}
          onStop={() => { engine.stop(); clearSectionLoop(); }}
        />
      </div>

      {/* ── Timeline 全幅 ── */}
      <div className="col-full">
        <TimelineEditor
          timeline={timeline}
          currentBar={status.currentBar}
          isPlaying={status.isPlaying}
          dimTempo={status.driverMode === "loop"}
          activeSectionId={activeSectionId}
          onTimelineChange={updateTimeline}
          onCurrentBarChange={handlePlayheadChange}
          onSectionClick={handleSectionClick}
        />
      </div>

      {/* ── M3 說明 ── */}
      <section className="card col-full">
        <h2 style={{ marginTop: 0 }}>M3 說明</h2>
        <p className="small">
          「快速變速」仍使用 playbackRate，適合低延遲驗證控制流程；「保音高模式」使用 AudioWorklet + WSOLA-inspired time-stretch 原型，會在重疊區搜尋相似波形再交叉淡化，以改善 M1 粒狀 overlap-add 的模糊與割離感。這版不依賴外部 WASM 或商用 SDK，方便直接部署到 Vercel；音質仍屬實驗原型，後續可再加入 transient detection 或更成熟的免費 DSP 引擎。
        </p>
      </section>
    </main>
  );
}
