"use client";

import { useState } from "react";
import { AudioSourceMeta } from "@/lib/types";

type Props = {
  audioSource: AudioSourceMeta;
  onFileConfirmed: (file: File, audioOriginalBpm: number) => void;
};

export function FileLoader({ audioSource, onFileConfirmed }: Props) {
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingBpm, setPendingBpm] = useState("120");

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

      {/* 已確認狀態 */}
      {audioSource.userConfirmedBpm && !pendingFile && (
        <div className="small">
          已載入：{audioSource.fileName}
          ｜音檔基準 BPM：<strong>{audioSource.userConfirmedBpm}</strong>
        </div>
      )}

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
            <input
              className="input"
              type="number"
              value={pendingBpm}
              min={20}
              max={300}
              onChange={(e) => setPendingBpm(e.target.value)}
              style={{ width: 100 }}
            />
            <button className="btn" title="半速修正" onClick={() => setPendingBpm(String(Math.round(bpmNum / 2)))}>÷2</button>
            <button className="btn" title="雙速修正" onClick={() => setPendingBpm(String(bpmNum * 2))}>×2</button>
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
