"use client";

import { useMemo, useRef, useState } from "react";
import { FileLoader } from "@/components/FileLoader";
import { LiveBeatPanel } from "@/components/LiveBeatPanel";
import { TapTempoPad } from "@/components/TapTempoPad";
import { TimelineEditor } from "@/components/TimelineEditor";
import { TransportBar } from "@/components/TransportBar";
import { BrowserLoopEngine, EngineStatus } from "@/lib/audioEngine";
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
    tempoRatio: 1
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
        <h1 className="title">Loop Harmonizer M0 Web</h1>
        <p className="subtitle">流程播放、段落時間軸、Tempo 錨點、即時切 beat 線性緩衝、Tap Tempo + Vercel API。</p>
      </header>

      <TransportBar
        loaded={loaded}
        isPlaying={status.isPlaying}
        currentBar={status.currentBar}
        currentBpm={status.currentBpm}
        timelineBpm={status.timelineBpm}
        tempoRatio={status.tempoRatio}
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
        <h2 style={{ marginTop: 0 }}>M0 限制</h2>
        <p className="small">
          目前使用 Web Audio playbackRate 驗證控制流程，所以變速時音高會跟著改變。下一版要做「變速不變調」時，建議改成 AudioWorklet + SoundTouchJS / RubberBand WASM。
        </p>
      </section>
    </main>
  );
}
