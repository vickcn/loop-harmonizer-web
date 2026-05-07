"use client";

type Props = {
  loaded: boolean;
  isPlaying: boolean;
  currentBar: number;
  currentBpm: number;
  timelineBpm: number;
  tempoRatio: number;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
};

export function TransportBar(props: Props) {
  return (
    <div className="card row" style={{ justifyContent: "space-between" }}>
      <div className="row">
        <button className="btn primary" disabled={!props.loaded} onClick={props.onPlay}>播放</button>
        <button className="btn" disabled={!props.loaded} onClick={props.onPause}>暫停</button>
        <button className="btn" disabled={!props.loaded} onClick={props.onStop}>停止</button>
      </div>
      <div className="row">
        <span className="label">Bar</span><strong>{props.currentBar.toFixed(2)}</strong>
        <span className="label">Timeline BPM</span><strong>{props.timelineBpm.toFixed(1)}</strong>
        <span className="label">Actual BPM</span><strong>{props.currentBpm.toFixed(1)}</strong>
        <span className="label">Ratio</span><strong>{props.tempoRatio.toFixed(3)}x</strong>
      </div>
    </div>
  );
}
