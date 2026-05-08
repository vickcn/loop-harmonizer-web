"use client";

import { useEffect, useMemo, useState } from "react";
import { calculateTapBpm } from "@/lib/tapTempo";
import { BeatAnalyzeResponse } from "@/lib/types";

type TapTarget = "liveBeat" | "audioBase";

type Props = {
  songId: string;
  currentTimelineBpm: number;
  onSuggestedBpm: (bpm: number, transitionBeats: number) => void;
  onSuggestedBaseBpm: (bpm: number) => void;
};

export function TapTempoPad({ songId, currentTimelineBpm, onSuggestedBpm, onSuggestedBaseBpm }: Props) {
  const [requiredTaps, setRequiredTaps] = useState(4);
  const [tapTimes, setTapTimes] = useState<number[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [tapTarget, setTapTarget] = useState<TapTarget>("liveBeat");
  const bpm = useMemo(() => calculateTapBpm(tapTimes), [tapTimes]);

  const tap = async () => {
    const next = [...tapTimes, performance.now()].slice(-requiredTaps);
    setTapTimes(next);
    if (next.length === requiredTaps) {
      const rawDetectedBpm = calculateTapBpm(next);

      if (tapTarget === "audioBase") {
        // 直接用前端算出的 BPM 設定音檔基準，不送 API
        if (rawDetectedBpm) onSuggestedBaseBpm(rawDetectedBpm);
        setTapTimes([]);
        return;
      }

      setIsSending(true);
      try {
        const res = await fetch("/api/beat/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ songId, requiredTaps, tapTimes: next, rawDetectedBpm, currentTimelineBpm })
        });
        const data = (await res.json()) as BeatAnalyzeResponse;
        onSuggestedBpm(data.suggestedBpm, data.transition.beats);
      } finally {
        setIsSending(false);
      }
    }
  };

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.code === "Space") { event.preventDefault(); void tap(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  return (
    <div className="card grid">
      <div>
        <h2 style={{ margin: 0 }}>Tap Tempo</h2>
        <p className="small">在下方區域點擊，或按空白鍵敲拍。敲滿指定拍數後套用到選定目標。</p>
      </div>
      <div className="row">
        <label className="row">
          <span className="label">偵測拍數</span>
          <select className="input" value={requiredTaps} onChange={(e) => { setRequiredTaps(Number(e.target.value)); setTapTimes([]); }}>
            <option value={4}>4</option>
            <option value={8}>8</option>
            <option value={16}>16</option>
          </select>
        </label>
        <label className="row">
          <span className="label">套用到</span>
          <select className="input" value={tapTarget} onChange={(e) => { setTapTarget(e.target.value as TapTarget); setTapTimes([]); }}>
            <option value="liveBeat">變速目標 BPM</option>
            <option value="audioBase">音檔基準 BPM</option>
          </select>
        </label>
        <button className="btn" onClick={() => setTapTimes([])}>重新敲</button>
      </div>
      <button className="tap-pad" onClick={tap}>
        <div>
          <div style={{ fontSize: 24, fontWeight: 800, color: isSending ? undefined : "#8ab4f8" }}>{isSending ? "分析中..." : "點擊 / 空白鍵敲拍"}</div>
          <div className="small">{tapTimes.length} / {requiredTaps} 拍｜偵測 BPM：{bpm ? bpm.toFixed(1) : "--"}</div>
        </div>
      </button>
    </div>
  );
}
