"use client";

import { useState } from "react";

type Props = {
  targetBpm: number;
  transitionBeats: number;
  onTargetBpmChange: (bpm: number) => void;
  onTransitionBeatsChange: (beats: number) => void;
  onApply: () => void;
  onApplyDirect: () => void;
};

export function LiveBeatPanel({ targetBpm, transitionBeats, onTargetBpmChange, onTransitionBeatsChange, onApply, onApplyDirect }: Props) {
  const [inputVal, setInputVal] = useState("");
  const clamp = (v: number) => Math.max(20, Math.min(300, v));

  const displayVal = inputVal !== "" ? inputVal : String(targetBpm);

  const commit = (raw: string) => {
    const n = Number(raw);
    if (!isNaN(n) && raw.trim() !== "") onTargetBpmChange(clamp(Math.round(n)));
    setInputVal("");
  };

  return (
    <div className="card grid">
      <div>
        <h2 style={{ margin: 0 }}>即時切 Beat</h2>
        <p className="small">可選擇依設定 beat 數線性緩衝，或直接切到目標 BPM。</p>
      </div>
      <div className="row">
        <label className="row">
          <span className="label">目標 BPM</span>
          <button className="btn" onClick={() => { setInputVal(""); onTargetBpmChange(clamp(targetBpm - 1)); }}>−</button>
          <input
            className="input"
            type="number"
            value={displayVal}
            style={{ width: 72 }}
            onChange={(e) => setInputVal(e.target.value)}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") commit((e.target as HTMLInputElement).value); }}
          />
          <button className="btn" onClick={() => { setInputVal(""); onTargetBpmChange(clamp(targetBpm + 1)); }}>+</button>
        </label>
        <label className="row">
          <span className="label">緩衝拍數</span>
          <select className="input" value={transitionBeats} onChange={(e) => onTransitionBeatsChange(Number(e.target.value))}>
            <option value={4}>4 beats</option>
            <option value={8}>8 beats</option>
            <option value={16}>16 beats</option>
          </select>
        </label>
        <button className="btn primary" onClick={onApply}>線性切過去</button>
        <button className="btn" onClick={onApplyDirect}>直接切過去</button>
      </div>
    </div>
  );
}
