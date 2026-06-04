"use client";

import { useEffect, useRef, useState } from "react";

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
  const [collapsed, setCollapsed] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [flashOn, setFlashOn] = useState(false);
  const previewIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const previewFlashRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPreviewTimers = () => {
    if (previewIntervalRef.current) { clearInterval(previewIntervalRef.current); previewIntervalRef.current = null; }
    if (previewFlashRef.current) { clearTimeout(previewFlashRef.current); previewFlashRef.current = null; }
  };

  useEffect(() => {
    if (!previewing) {
      clearPreviewTimers();
      setFlashOn(false);
      return;
    }
    const flash = () => {
      setFlashOn(true);
      previewFlashRef.current = setTimeout(() => setFlashOn(false), 120);
    };
    flash(); // 第一拍立即閃
    const ms = Math.round(60000 / targetBpm);
    previewIntervalRef.current = setInterval(flash, ms);
    return clearPreviewTimers;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewing, targetBpm]);
  const clamp = (v: number) => Math.max(20, Math.min(300, v));

  const displayVal = inputVal !== "" ? inputVal : String(targetBpm);


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
      <div
        className="row"
        style={{ justifyContent: "space-between", cursor: "pointer", userSelect: "none" }}
        onClick={() => setCollapsed((v) => !v)}
      >
        <div>
          <h2 style={{ margin: 0 }}>即時切 Beat</h2>
          {!collapsed && <p className="small" style={{ margin: 0 }}>可選擇依設定 beat 數線性緩衝，或直接切到目標 BPM。</p>}
        </div>
        <span style={{ opacity: 0.4, fontSize: 12, alignSelf: "flex-start", paddingTop: 4 }}>{collapsed ? "▶" : "▼"}</span>
      </div>
      {!collapsed && <>
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
        <label className="row" style={{ fontSize: 15 }}>
          <span className="label" style={{ fontSize: 15 }}>目標 BPM</span>
          <button className="btn" style={{ fontSize: 15, padding: "5px 10px" }} onClick={() => { setInputVal(""); onTargetBpmChange(clamp(targetBpm - 1)); }}>−</button>
          <datalist id="bpm-presets-list">
            {bpmPresets.map((bpm) => (
              <option key={bpm} value={bpm} />
            ))}
          </datalist>
          <input
            className="input"
            type="number"
            list="bpm-presets-list"
            value={displayVal}
            style={{ width: 96, fontSize: 16, fontWeight: 700 }}
            onChange={(e) => {
              setInputVal(e.target.value);
              // 從 datalist 選取時 onChange 立即觸發，直接 commit
              const v = parseFloat(e.target.value);
              if (!isNaN(v) && bpmPresets.includes(v)) commit(e.target.value);
            }}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") commit((e.target as HTMLInputElement).value); }}
          />
          <button className="btn" style={{ fontSize: 15, padding: "5px 10px" }} onClick={() => { setInputVal(""); onTargetBpmChange(clamp(targetBpm + 1)); }}>+</button>
          <button className="btn" style={{ fontSize: 12, padding: "5px 9px" }} onClick={() => addPreset(targetBpm)} title="記憶目前 BPM">＋記憶</button>
          <span style={{
            display: "inline-block",
            width: 16,
            height: 16,
            borderRadius: "50%",
            flexShrink: 0,
            background: flashOn ? "#22c55e" : "var(--muted)",
            boxShadow: flashOn ? "0 0 10px #22c55e, 0 0 20px #22c55e66" : "none",
            transition: flashOn ? "none" : "background 0.12s, box-shadow 0.12s",
          }} />
          <button
            className={`btn${previewing ? " primary" : ""}`}
            style={{ fontSize: 14, padding: "5px 11px" }}
            onClick={() => setPreviewing((v) => !v)}
          >
            {previewing ? "■ 停止" : "▶ 預覽"}
          </button>
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
      </>}
    </div>
  );
}
