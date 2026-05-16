"use client";

import { useEffect, useMemo, useState } from "react";

const BPM_PRESETS_STORAGE_KEY = "loop-harmonizer.liveBeat.bpmPresets";

type Props = {
  targetBpm: number;
  transitionBeats: number;
  canSaveAsAudioBase: boolean;
  onTargetBpmChange: (bpm: number) => void;
  onTransitionBeatsChange: (beats: number) => void;
  onApply: () => void;
  onApplyDirect: () => void;
  onSaveAsAudioBase: () => void;
  onApplyPreset: (bpm: number) => void;
  onApplyDirectPreset: (bpm: number) => void;
};

export function LiveBeatPanel({
  targetBpm,
  transitionBeats,
  canSaveAsAudioBase,
  onTargetBpmChange,
  onTransitionBeatsChange,
  onApply,
  onApplyDirect,
  onSaveAsAudioBase,
  onApplyPreset,
  onApplyDirectPreset,
}: Props) {
  const [inputVal, setInputVal] = useState("");
  const [bpmPresets, setBpmPresets] = useState<number[]>([]);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const clamp = (v: number) => Math.max(20, Math.min(300, v));

  const displayVal = inputVal !== "" ? inputVal : String(targetBpm);
  const selectedPresetValue = useMemo(
    () => (bpmPresets.includes(targetBpm) ? String(targetBpm) : ""),
    [bpmPresets, targetBpm]
  );

  useEffect(() => {
    try {
      const raw = localStorage.getItem(BPM_PRESETS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const restored = parsed
        .map((value) => Number(value))
        .filter((value, index, arr) => Number.isFinite(value) && arr.indexOf(value) === index)
        .map((value) => clamp(Math.round(value)));
      setBpmPresets(restored);
    } catch {
      setBpmPresets([]);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(BPM_PRESETS_STORAGE_KEY, JSON.stringify(bpmPresets));
  }, [bpmPresets]);

  const commit = (raw: string) => {
    const n = Number(raw);
    if (!isNaN(n) && raw.trim() !== "") onTargetBpmChange(clamp(Math.round(n)));
    setInputVal("");
  };

  const addPreset = (bpm: number) => {
    const next = clamp(Math.round(bpm));
    setBpmPresets((prev) => (prev.includes(next) ? prev : [...prev, next]));
  };

  const removePreset = (bpm: number) => {
    setBpmPresets((prev) => prev.filter((value) => value !== bpm));
  };

  const adjustPreset = (index: number, delta: number) => {
    setBpmPresets((prev) => {
      const next = [...prev];
      next[index] = clamp(next[index] + delta);
      return next;
    });
  };

  const movePreset = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;
    setBpmPresets((prev) => {
      if (fromIndex >= prev.length || toIndex >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  };

  return (
    <div className="card grid">
      <div>
        <h2 style={{ margin: 0 }}>即時切 Beat</h2>
        <p className="small">可選擇依設定 beat 數線性緩衝，或直接切到目標 BPM。</p>
      </div>
      <div className="row">
        <label className="row">
          <span className="label">記憶 BPM</span>
          <select
            className="input"
            value={selectedPresetValue}
            onChange={(e) => {
              if (e.target.value === "") return;
              const next = Number(e.target.value);
              if (!Number.isNaN(next)) onTargetBpmChange(next);
            }}
          >
            <option value="">選擇記憶值</option>
            {bpmPresets.map((bpm) => (
              <option key={bpm} value={bpm}>{bpm}</option>
            ))}
          </select>
          <button className="btn" onClick={() => addPreset(targetBpm)}>加入記憶</button>
        </label>
      </div>
      {bpmPresets.length > 0 && (
        <div className="grid" style={{ gap: 8 }}>
          {bpmPresets.map((bpm, index) => (
            <div
              key={bpm}
              className="row"
              draggable
              onDragStart={() => setDraggingIndex(index)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (draggingIndex !== null) movePreset(draggingIndex, index);
                setDraggingIndex(null);
              }}
              onDragEnd={() => setDraggingIndex(null)}
              style={{
                justifyContent: "space-between",
                background: "#10131b",
                border: "1px solid var(--line)",
                borderRadius: 12,
                padding: "8px 10px",
                opacity: draggingIndex === index ? 0.6 : 1,
              }}
            >
              <div className="row" style={{ gap: 4 }}>
                <button className="btn" style={{ padding: "6px 8px" }} onClick={() => adjustPreset(index, -1)}>−</button>
                <button className="btn" style={{ padding: "6px 10px", minWidth: 80 }} onClick={() => onTargetBpmChange(bpmPresets[index])}>
                  BPM {bpm}
                </button>
                <button className="btn" style={{ padding: "6px 8px" }} onClick={() => adjustPreset(index, 1)}>+</button>
              </div>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn primary" style={{ padding: "6px 10px" }} onClick={() => onApplyPreset(bpm)}>
                  線性切
                </button>
                <button className="btn" style={{ padding: "6px 10px" }} onClick={() => onApplyDirectPreset(bpm)}>
                  直接切
                </button>
                <span className="small" style={{ cursor: "grab" }}>拖曳排序</span>
                <button className="btn danger" style={{ padding: "6px 10px" }} onClick={() => removePreset(bpm)}>
                  刪除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
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
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn" disabled={!canSaveAsAudioBase} onClick={onSaveAsAudioBase}>
          記為音檔基準 BPM
        </button>
      </div>
    </div>
  );
}
