"use client";

type Props = {
  originalBpm: number;
  onOriginalBpmChange: (bpm: number) => void;
  onFile: (file: File) => void;
};

export function FileLoader({ originalBpm, onOriginalBpmChange, onFile }: Props) {
  return (
    <div className="card grid">
      <div>
        <h2 style={{ margin: 0 }}>Loop 載入</h2>
        <p className="small">M0 先用 Web Audio playbackRate 驗證流程；正式保音高變速可再換 AudioWorklet / WASM。</p>
      </div>
      <div className="row">
        <input className="input" type="file" accept="audio/*" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
        <label className="row">
          <span className="label">原始 BPM</span>
          <input className="input" type="number" value={originalBpm} onChange={(e) => onOriginalBpmChange(Number(e.target.value) || 120)} />
        </label>
      </div>
    </div>
  );
}
