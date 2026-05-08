"use client";

import { useState } from "react";
import { AudioSourceMeta } from "@/lib/types";

type Props = {
  audioSource: AudioSourceMeta;
  onFileConfirmed: (file: File, audioOriginalBpm: number) => void;
  onAudioBpmChange: (bpm: number) => void;
};

export function FileLoader({ audioSource, onFileConfirmed, onAudioBpmChange }: Props) {
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingBpm, setPendingBpm] = useState("120");
  const [editBpm, setEditBpm] = useState("");

  const handleFileChange = (file: File) => {
    setPendingFile(file);
    const initial = audioSource.userConfirmedBpm ?? audioSource.detectedBpm ?? 120;
    setPendingBpm(String(Math.round(initial)));
  };

  const bpmNum = Math.max(20, Number(pendingBpm) || 120);

  const confirm = () => {
    if (!pendingFile) return;
    onFileConfirmed(pendingFile, bpmNum);
    setPendingFile(null);
  };

  return (
    <div className="card grid">
      <h2 style={{ margin: 0 }}>Loop 載入</h2>

      <input
        className="input"
        type="file"
        accept="audio/*"
        onChange={(e) => e.target.files?.[0] && handleFileChange(e.target.files[0])}
      />

      {/* 已確認狀態：可在線微調 BPM */}
      {audioSource.userConfirmedBpm && !pendingFile && (() => {
        const confirmed = audioSource.userConfirmedBpm!;
        const editVal = editBpm !== "" ? editBpm : String(confirmed);
        const editNum = Math.max(20, Number(editVal) || confirmed);
        const commit = (val: number) => { setEditBpm(""); onAudioBpmChange(val); };
        return (
          <div className="grid" style={{ gap: 6 }}>
            <div className="small">已載入：{audioSource.fileName}</div>
            <div className="row">
              <span className="label">音檔基準 BPM</span>
              <button className="btn" onClick={() => commit(Math.max(20, editNum - 1))}>−</button>
              <input
                className="input"
                type="number"
                value={editVal}
                min={20} max={300}
                style={{ width: 72 }}
                onChange={(e) => setEditBpm(e.target.value)}
                onBlur={() => editBpm !== "" && commit(editNum)}
                onKeyDown={(e) => e.key === "Enter" && editBpm !== "" && commit(editNum)}
              />
              <button className="btn" onClick={() => commit(Math.min(300, editNum + 1))}>+</button>
              <button className="btn" onClick={() => commit(Math.round(editNum / 2))}>÷2</button>
              <button className="btn" onClick={() => commit(Math.min(300, editNum * 2))}>×2</button>
            </div>
          </div>
        );
      })()}

      {/* BPM 確認面板 */}
      {pendingFile && (
        <div style={{ background: "#1a2035", borderRadius: 12, padding: "16px", display: "grid", gap: 12 }}>
          <div className="small">已選取：<strong>{pendingFile.name}</strong></div>

          {audioSource.detectedBpm ? (
            <div className="small">系統推測 BPM：<strong>{audioSource.detectedBpm.toFixed(1)}</strong></div>
          ) : (
            <div className="small" style={{ opacity: 0.5 }}>系統推測 BPM：---（請手動輸入）</div>
          )}

          <p className="small" style={{ margin: 0 }}>請確認此音檔原始 BPM：</p>

          <div className="row">
            <button className="btn" onClick={() => setPendingBpm(String(Math.max(20, bpmNum - 1)))}>−</button>
            <input
              className="input"
              type="number"
              value={pendingBpm}
              min={20}
              max={300}
              onChange={(e) => setPendingBpm(e.target.value)}
              style={{ width: 72 }}
            />
            <button className="btn" onClick={() => setPendingBpm(String(Math.min(300, bpmNum + 1)))}>+</button>
            <button className="btn" title="半速修正" onClick={() => setPendingBpm(String(Math.round(bpmNum / 2)))}>÷2</button>
            <button className="btn" title="雙速修正" onClick={() => setPendingBpm(String(Math.min(300, bpmNum * 2)))}>×2</button>
          </div>

          <div className="row">
            <button className="btn primary" onClick={confirm}>確認並載入</button>
            <button className="btn" onClick={() => setPendingFile(null)}>取消</button>
          </div>
        </div>
      )}
    </div>
  );
}
