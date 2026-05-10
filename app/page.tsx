"use client";

import { useMemo, useRef, useState } from "react";
import { FileLoader } from "@/components/FileLoader";
import { LiveBeatPanel } from "@/components/LiveBeatPanel";
import { MetronomePanel } from "@/components/MetronomePanel";
import { TapTempoPad } from "@/components/TapTempoPad";
import { TimelineEditor } from "@/components/TimelineEditor";
import { TransportBar } from "@/components/TransportBar";
import { BrowserLoopEngine, DriverMode, EngineStatus, PlaybackMode } from "@/lib/audioEngine";
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

  const handleFileConfirmed = async (file: File, audioOriginalBpm: number) => {
    const audioSource: AudioSourceMeta = {
      id: `audio_${Date.now()}`,
      fileName: file.name,
      userConfirmedBpm: audioOriginalBpm,
    };
    // projectBpm 預設對齊音檔基準 BPM，使用者可之後用 live beat 調整
    const nextTimeline: SongTimeline = { ...timeline, projectBpm: audioOriginalBpm, audioSource };
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
    engine.setMetronomeSound(sound);
    // briefly enable metronome and play one tick via standalone
    engine.setMetronomeEnabled(true);
    void engine.play();
    setTimeout(() => {
      engine.stop();
      engine.setMetronomeEnabled(metronomeEnabled);
      engine.setMetronomeSound(findSound(allSounds, currentSoundId));
    }, 700);
  };

  const triggerLiveBeat = (bpm = targetBpm, beats = transitionBeats, isDirect = false) => {
    setTargetBpm(bpm);
    setTransitionBeats(beats);
    engine.triggerLiveBeatChange(bpm, beats, isDirect);
  };

  const loopIsPlaying = status.isPlaying && status.driverMode === "loop";
  const timelineIsPlaying = status.isPlaying && status.driverMode === "timeline";

  return (
    <main className="container grid">
      <header>
        <h1 className="title">Loop Harmonizer M2A Web</h1>
        <p className="subtitle">流程播放、段落時間軸、Tempo 錨點、同步節拍器、即時切 beat 線性緩衝、Tap Tempo + Vercel API，並加入免費 WSOLA-inspired 保音高變速原型。</p>
      </header>

      {/* ── Loop 播放 ── */}
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
        onStop={() => engine.stop()}
      />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
        <div style={{ gridColumn: "1 / -1" }}>
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
        <TapTempoPad
          songId={timeline.id}
          currentTimelineBpm={status.loopBpm}
          onSuggestedBpm={(bpm, beats) => {
            setTargetBpm(bpm);
            setTransitionBeats(beats);
          }}
        />
      </div>

      {/* ── 載入音檔 ── */}
      <FileLoader
        audioSource={timeline.audioSource}
        onFileConfirmed={handleFileConfirmed}
        onAudioBpmChange={(bpm) => {
          updateTimeline({ ...timeline, audioSource: { ...timeline.audioSource, userConfirmedBpm: bpm } });
          setTargetBpm(bpm);
        }}
      />

      {/* ── Timeline 播放 ── */}
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
        onStop={() => engine.stop()}
      />

      <TimelineEditor timeline={timeline} currentBar={status.currentBar} dimTempo={status.driverMode === "loop"} onTimelineChange={updateTimeline} />

      <section className="card">
        <h2 style={{ marginTop: 0 }}>M2A 說明</h2>
        <p className="small">
          「快速變速」仍使用 playbackRate，適合低延遲驗證控制流程；「保音高模式」使用 AudioWorklet + WSOLA-inspired time-stretch 原型，會在重疊區搜尋相似波形再交叉淡化，以改善 M1 粒狀 overlap-add 的模糊與割離感。這版不依賴外部 WASM 或商用 SDK，方便直接部署到 Vercel；音質仍屬實驗原型，後續可再加入 transient detection 或更成熟的免費 DSP 引擎。
        </p>
      </section>
    </main>
  );
}
