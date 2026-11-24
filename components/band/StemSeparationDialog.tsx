"use client";

import { useEffect, useRef, useState } from "react";
import { separateAudio, type StemSeparationResult } from "@/lib/separation/stemSeparator";
import type { StemSeparationMode, StemType } from "@/lib/separation/stemTypes";
import { encodeStereoWav } from "@/lib/separation/wavEncoder";

type Props = {
  open: boolean;
  onClose: () => void;
  onAddStems: (result: StemSeparationResult, sourceFileName: string) => Promise<void> | void;
};

const STEM_LABELS: Record<StemType, string> = {
  vocals: "人聲",
  instrumental: "伴奏",
  drums: "鼓組",
  bass: "貝斯",
  other: "其他",
};

function downloadStem(fileName: string, stemType: StemType, left: Float32Array, right: Float32Array, sampleRate: number) {
  const baseName = fileName.replace(/\.[^.]+$/, "").replace(/[^\p{L}\p{N}_-]+/gu, "-") || "demucs-stem";
  const blob = new Blob([encodeStereoWav(left, right, sampleRate)], { type: "audio/wav" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${baseName}-${stemType}.wav`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function StemSeparationDialog({ open, onClose, onAddStems }: Props) {
  const fileRef = useRef<File | null>(null);
  const resultRef = useRef<StemSeparationResult | null>(null);
  const [fileName, setFileName] = useState("");
  const [mode, setMode] = useState<StemSeparationMode>("two_stem");
  const [runtimeHint, setRuntimeHint] = useState("偵測中…");
  const [status, setStatus] = useState("請選擇音訊檔案與分離模式。");
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [separationProgress, setSeparationProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const [resultSummary, setResultSummary] = useState<{ backend: string; stemTypes: StemType[] } | null>(null);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!open) return;
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter?: () => Promise<unknown> } }).gpu;
    if (!gpu?.requestAdapter) {
      setRuntimeHint("WebGPU 不可用，將使用 WASM（CPU）執行。");
      return;
    }
    void gpu.requestAdapter().then((adapter) => {
      setRuntimeHint(adapter ? "WebGPU 可用；若模型初始化失敗會自動改用 WASM。" : "WebGPU 不可用，將使用 WASM（CPU）執行。");
    }).catch(() => setRuntimeHint("WebGPU 不可用，將使用 WASM（CPU）執行。"));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !running && !adding) {
        event.preventDefault();
        resultRef.current = null;
        setResultSummary(null);
        setError("");
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, running, adding, onClose]);

  const close = () => {
    if (running || adding) return;
    resultRef.current = null;
    setResultSummary(null);
    setError("");
    onClose();
  };

  const startSeparation = async () => {
    const file = fileRef.current;
    if (!file) {
      setError("請先選擇一個音訊檔案。");
      return;
    }

    resultRef.current = null;
    setResultSummary(null);
    setError("");
    setDownloadProgress(0);
    setSeparationProgress(0);
    setProgressLabel("");
    setRunning(true);
    try {
      const result = await separateAudio(file, {
        mode,
        onStatus: setStatus,
        onDownloadProgress: setDownloadProgress,
        onProgress: (progress, currentSegment, totalSegments) => {
          setSeparationProgress(progress);
          setProgressLabel(`${currentSegment}/${totalSegments}`);
        },
      });
      resultRef.current = result;
      setResultSummary({
        backend: result.backend,
        stemTypes: result.stems?.tracks.map((track) => track.stemType) ?? [],
      });
      setStatus("分離完成。可先下載 WAV，或將全部分軌加入 Band Mixer。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "音軌分離失敗，請稍後重試。");
      setStatus("分離未完成。");
    } finally {
      setRunning(false);
    }
  };

  const addStems = async () => {
    const result = resultRef.current;
    if (!result || !fileName) return;
    setAdding(true);
    try {
      await onAddStems(result, fileName);
      resultRef.current = null;
      setResultSummary(null);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "無法將分軌加入 Band Mixer。");
    } finally {
      setAdding(false);
    }
  };

  if (!open) return null;

  const result = resultRef.current;
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  return (
    <div
      role="presentation"
      onMouseDown={close}
      style={{
        position: "fixed", inset: 0, zIndex: 50, display: "grid", placeItems: "center",
        padding: 16, background: "rgba(0, 0, 0, 0.68)",
      }}
    >
      <section
        className="card grid"
        role="dialog"
        aria-modal="true"
        aria-labelledby="stem-separation-title"
        onMouseDown={(event) => event.stopPropagation()}
        style={{ width: "min(680px, 100%)", maxHeight: "calc(100vh - 32px)", overflowY: "auto", gap: 16 }}
      >
        <div className="row" style={{ justifyContent: "space-between", gap: 12 }}>
          <div>
            <h2 id="stem-separation-title" style={{ margin: 0, fontSize: 20 }}>分離音軌</h2>
            <p className="small" style={{ margin: "6px 0 0", opacity: 0.65 }}>
              模型與推論完全在您的瀏覽器中執行，不會上傳到伺服器。
            </p>
          </div>
          <button type="button" className="btn" onClick={close} disabled={running || adding}>關閉</button>
        </div>

        <div className="grid" style={{ gap: 8 }}>
          <label className="small" htmlFor="stem-audio-file">音訊檔案</label>
          <input
            id="stem-audio-file"
            className="input"
            type="file"
            accept="audio/*"
            disabled={running || adding}
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              fileRef.current = file;
              setFileName(file?.name ?? "");
              setResultSummary(null);
              resultRef.current = null;
              setError("");
              setStatus(file ? "已選擇音訊檔案，準備開始分離。" : "請選擇音訊檔案與分離模式。");
            }}
          />
          {fileName && <span className="small" style={{ opacity: 0.65 }}>已選擇：{fileName}</span>}
        </div>

        <fieldset disabled={running || adding} style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="small" style={{ marginBottom: 8 }}>分離模式</legend>
          <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
            <label className="row" style={{ gap: 6, cursor: "pointer" }}>
              <input type="radio" name="stem-mode" checked={mode === "two_stem"} onChange={() => setMode("two_stem")} />
              <span>2 軌：人聲、伴奏</span>
            </label>
            <label className="row" style={{ gap: 6, cursor: "pointer" }}>
              <input type="radio" name="stem-mode" checked={mode === "four_stem"} onChange={() => setMode("four_stem")} />
              <span>4 軌：人聲、鼓組、貝斯、其他</span>
            </label>
          </div>
        </fieldset>

        <div className="grid" style={{ gap: 6, padding: 12, border: "1px solid var(--line)", borderRadius: 10 }}>
          <strong style={{ fontSize: 14 }}>執行環境</strong>
          <span className="small" style={{ opacity: 0.72 }}>{runtimeHint}</span>
          <span className="small" style={{ color: "var(--warning)", opacity: 0.9 }}>
            {isMobile ? "行動裝置通常不適合執行大型模型，建議改在桌面版瀏覽器處理。" : "分離時會占用較多記憶體與 GPU／CPU；請保持此分頁開啟。"}
          </span>
        </div>

        <div className="grid" style={{ gap: 8 }} aria-live="polite">
          <span className="small">{status}</span>
          <label className="small">模型下載 {downloadProgress > 0 ? `${Math.round(downloadProgress * 100)}%` : "尚未開始"}</label>
          <progress value={downloadProgress} max={1} style={{ width: "100%" }} />
          <label className="small">分離進度 {separationProgress > 0 ? `${Math.round(separationProgress * 100)}%${progressLabel ? ` · ${progressLabel}` : ""}` : "尚未開始"}</label>
          <progress value={separationProgress} max={1} style={{ width: "100%" }} />
        </div>

        {error && <div role="alert" style={{ color: "var(--danger)", fontSize: 14 }}>{error}</div>}

        {resultSummary && result && (
          <div className="grid" style={{ gap: 10, padding: 12, border: "1px solid var(--accent)", borderRadius: 10 }}>
            <div className="row" style={{ justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <strong>分離結果（{resultSummary.backend === "webgpu" ? "WebGPU" : "WASM"}）</strong>
              <span className="small" style={{ opacity: 0.65 }}>{resultSummary.stemTypes.map((type) => STEM_LABELS[type]).join("、")}</span>
            </div>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <button type="button" className="btn primary" onClick={() => void addStems()} disabled={adding}>
                {adding ? "加入中…" : "＋ 將全部分軌加入 Band Mixer"}
              </button>
              {result.stems?.tracks.map((stem) => (
                <button
                  type="button"
                  className="btn"
                  key={stem.stemType}
                  onClick={() => downloadStem(fileName, stem.stemType, stem.left, stem.right, result.stems!.sampleRate)}
                >
                  ↓ {STEM_LABELS[stem.stemType]} WAV
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn primary" onClick={() => void startSeparation()} disabled={running || adding || !fileName}>
            {running ? "分離中…" : "開始分離"}
          </button>
        </div>
      </section>
    </div>
  );
}
