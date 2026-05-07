"use client";

import { useMemo, useRef, useState } from "react";
import { FileLoader } from "@/components/FileLoader";
import { LiveBeatPanel } from "@/components/LiveBeatPanel";
import { TapTempoPad } from "@/components/TapTempoPad";
import { TimelineEditor } from "@/components/TimelineEditor";
import { TransportBar } from "@/components/TransportBar";
import { BrowserLoopEngine, EngineStatus, PlaybackMode } from "@/lib/audioEngine";
import { defaultTimeline } from "@/lib/timeline";
import { SongTimeline } from "@/lib/types";

export default function Page() {
  const [timeline, setTimeline] = useState<SongTimeline>(defaultTimeline);
  const [loaded, setLoaded] = useState(false);
  const [fileName, setFileName] = useState<string>("");
  const [targetBpm, setTargetBpm] = useState(132);
  const [transitionBeats, setTransitionBeats] = useState(8);
  const [status, setStatus] = useState<EngineStatus>({
    isPlaying: false,
    currentBar: 1,
    currentBpm: timeline.originalBpm,
    timelineBpm: timeline.originalBpm,
    actualBpm: timeline.originalBpm,
    tempoRatio: 1,
    playbackMode: "quick",
    pitchPreserveReady: false
  });

  const engineRef = useRef<BrowserLoopEngine | null>(null);

  const engine = useMemo(() => {
    if (!engineRef.current) {
      engineRef.current = new BrowserLoopEngine(timeline);
      engineRef.current.setStatusCallback(setStatus);
    }
    return engineRef.current;
  }, []);

  const updateTimeline = (next: SongTimeline) => {
    setTimeline(next);
    engine.setTimeline(next);
  };

  const setOriginalBpm = (bpm: number) => {
    updateTimeline({ ...timeline, originalBpm: bpm });
  };

  const loadFile = async (file: File) => {
    await engine.loadFile(file);
    setLoaded(true);
    setFileName(file.name);
  };

  const triggerLiveBeat = (bpm = targetBpm, beats = transitionBeats) => {
    setTargetBpm(bpm);
    setTransitionBeats(beats);
    engine.triggerLiveBeatChange(bpm, beats);
  };

  return (
    <main className="container grid">
      <header>
        <h1 className="title">Loop Harmonizer M1 Web</h1>
        <p className="subtitle">流程播放、段落時間軸、Tempo 錨點、即時切 beat 線性緩衝、Tap Tempo + Vercel API，並加入變速不變調模式。</p>
      </header>

      <TransportBar
        loaded={loaded}
        isPlaying={status.isPlaying}
        currentBar={status.currentBar}
        currentBpm={status.currentBpm}
        timelineBpm={status.timelineBpm}
        tempoRatio={status.tempoRatio}
        playbackMode={status.playbackMode}
        pitchPreserveReady={status.pitchPreserveReady}
        onPlaybackModeChange={(mode: PlaybackMode) => void engine.setPlaybackMode(mode)}
        onPlay={() => void engine.play()}
        onPause={() => engine.pause()}
        onStop={() => engine.stop()}
      />

      <FileLoader originalBpm={timeline.originalBpm} onOriginalBpmChange={setOriginalBpm} onFile={loadFile} />
      {fileName && <div className="small">已載入：{fileName}</div>}

      <TimelineEditor timeline={timeline} currentBar={status.currentBar} onTimelineChange={updateTimeline} />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
        <LiveBeatPanel
          targetBpm={targetBpm}
          transitionBeats={transitionBeats}
          onTargetBpmChange={setTargetBpm}
          onTransitionBeatsChange={setTransitionBeats}
          onApply={() => triggerLiveBeat()}
        />
        <TapTempoPad
          songId={timeline.id}
          currentTimelineBpm={status.timelineBpm}
          onSuggestedBpm={(bpm, beats) => triggerLiveBeat(bpm, beats)}
        />
      </div>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>M1 說明</h2>
        <p className="small">
          「快速變速」仍使用 playbackRate，適合低延遲驗證控制流程；「M1 變速不變調」使用 AudioWorklet 粒狀 overlap-add time-stretch 原型，會盡量維持音高。這版不依賴外部 WASM 套件，方便直接部署到 Vercel；音質可在下一版再替換為 SoundTouchJS / RubberBand WASM。
        </p>
      </section>
    </main>
  );
}
