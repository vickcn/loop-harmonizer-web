"use client";

type Props = {
  enabled: boolean;
  accentFirstBeat: boolean;
  metronomeVolume: number;
  audioVolume: number;
  // standalone play: only available when no audio is loaded
  standaloneIsPlaying: boolean;
  onStandalonePlay: () => void;
  onStandaloneStop: () => void;
  onEnabledChange: (v: boolean) => void;
  onAccentChange: (v: boolean) => void;
  onMetronomeVolumeChange: (v: number) => void;
  onAudioVolumeChange: (v: number) => void;
};

export function MetronomePanel({
  enabled, accentFirstBeat, metronomeVolume, audioVolume,
  standaloneIsPlaying, onStandalonePlay, onStandaloneStop,
  onEnabledChange, onAccentChange, onMetronomeVolumeChange, onAudioVolumeChange,
}: Props) {
  return (
    <div className="card grid">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>節拍器</h2>
        {enabled && (
          <button
            className={`btn${standaloneIsPlaying ? " danger" : " primary"}`}
            style={{ padding: "6px 14px" }}
            onClick={standaloneIsPlaying ? onStandaloneStop : onStandalonePlay}
          >
            {standaloneIsPlaying ? "⏹ 停止" : "▶ 純節拍器"}
          </button>
        )}
      </div>
      <div className="row">
        <label className="row" style={{ gap: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={enabled} onChange={(e) => onEnabledChange(e.target.checked)} />
          <span>開啟節拍器</span>
        </label>
        <label className="row" style={{ gap: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={accentFirstBeat} disabled={!enabled} onChange={(e) => onAccentChange(e.target.checked)} />
          <span style={{ opacity: enabled ? 1 : 0.4 }}>第一拍重音</span>
        </label>
      </div>
      <div className="row" style={{ flexWrap: "wrap", gap: 16 }}>
        <label className="row">
          <span className="label">節拍器音量</span>
          <input
            type="range" min={0} max={1} step={0.01}
            value={metronomeVolume}
            disabled={!enabled}
            onChange={(e) => onMetronomeVolumeChange(Number(e.target.value))}
            style={{ width: 120 }}
          />
          <span className="small" style={{ minWidth: 36 }}>{Math.round(metronomeVolume * 100)}%</span>
        </label>
        <label className="row">
          <span className="label">音檔音量</span>
          <input
            type="range" min={0} max={1} step={0.01}
            value={audioVolume}
            onChange={(e) => onAudioVolumeChange(Number(e.target.value))}
            style={{ width: 120 }}
          />
          <span className="small" style={{ minWidth: 36 }}>{Math.round(audioVolume * 100)}%</span>
        </label>
      </div>
    </div>
  );
}
