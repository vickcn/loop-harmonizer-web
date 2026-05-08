"use client";

import { PlaybackMode } from "@/lib/audioEngine";

type Props = {
  title: string;
  loaded: boolean;
  isPlaying: boolean;
  isActive: boolean;
  currentBar: number;
  currentBpm: number;
  timelineBpm: number;
  tempoRatio: number;
  playbackMode: PlaybackMode;
  pitchPreserveReady: boolean;
  showModeSelector?: boolean;
  onPlaybackModeChange: (mode: PlaybackMode) => void;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
};

export function TransportBar({ showModeSelector = true, ...props }: Props) {
  return (
    <div className="card grid" style={{ opacity: props.isActive ? 1 : 0.5 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="row">
          <h2 style={{ margin: 0 }}>{props.title}</h2>
          <button className="btn primary" disabled={!props.loaded} onClick={props.onPlay}>播放</button>
          <button className="btn" disabled={!props.loaded || !props.isPlaying} onClick={props.onPause}>暫停</button>
          <button className="btn" disabled={!props.loaded} onClick={props.onStop}>停止</button>
        </div>
        {showModeSelector && (
          <label className="row">
            <span className="label">播放模式</span>
            <select
              className="input"
              value={props.playbackMode}
              onChange={(event) => props.onPlaybackModeChange(event.target.value as PlaybackMode)}
            >
              <option value="quick">快速變速：會變調</option>
              <option value="pitch-preserve">M1 變速不變調</option>
            </select>
          </label>
        )}
      </div>
      {props.isActive && (
        <div className="row">
          <span className="label">Bar</span><strong>{props.currentBar.toFixed(2)}</strong>
          <span className="label">BPM</span><strong>{props.timelineBpm.toFixed(1)}</strong>
          <span className="label">Actual</span><strong>{props.currentBpm.toFixed(1)}</strong>
          <span className="label">Ratio</span><strong>{props.tempoRatio.toFixed(3)}x</strong>
          <span className="label">Pitch</span><strong>{props.pitchPreserveReady ? "ready" : "standby"}</strong>
        </div>
      )}
    </div>
  );
}
