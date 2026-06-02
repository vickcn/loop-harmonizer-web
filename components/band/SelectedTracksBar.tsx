"use client";

import { BandTrack } from "@/lib/band/bandTypes";

type Props = {
  tracks: BandTrack[];
  onPlaySelected: () => void;
  onPauseSelected: () => void;
  onStopSelected: () => void;
};

export function SelectedTracksBar({ tracks, onPlaySelected, onPauseSelected, onStopSelected }: Props) {
  const count = tracks.filter((t) => t.selected).length;
  const disabled = count === 0;

  return (
    <div
      className="card row"
      style={{ flexWrap: "wrap", gap: 12, background: disabled ? undefined : "#1a2035" }}
    >
      <span className="small" style={{ opacity: disabled ? 0.4 : 0.8 }}>
        已選 <strong>{count}</strong> 軌
      </span>
      <button className="btn primary" disabled={disabled} onClick={onPlaySelected}>▶ 播放所選</button>
      <button className="btn" disabled={disabled} onClick={onPauseSelected}>⏸ 暫停所選</button>
      <button className="btn" disabled={disabled} onClick={onStopSelected}>■ 停止所選</button>
    </div>
  );
}
