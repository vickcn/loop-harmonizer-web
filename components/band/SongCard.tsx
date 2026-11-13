"use client";

import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
import type { BandSong, StemChannel } from "@/lib/band/bandTypes";
import type { StemSeparationMode } from "@/lib/separation/stemTypes";
import { getEffectivePlaybackRate } from "@/lib/band/songModel";
import { TrackPlayhead } from "./TrackPlayhead";
import { StemMixer } from "./StemMixer";
import { IconActionButton } from "./IconActionButton";
import { AdaptiveActionRow, type AdaptiveActionItem } from "./AdaptiveActionRow";

type Props = {
  song: BandSong;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onChange: (patch: Partial<BandSong>) => void;
  onPlayPause: () => void;
  onStop: () => void;
  onSeek: (seconds: number) => void;
  onSeparate: (mode: StemSeparationMode) => void;
  onSwitchSource: (source: "original" | "stems") => void;
  onStemChange: (id: string, patch: Partial<StemChannel>) => void;
  onDownloadStem: (id: string) => void;
  onClearSongCache: () => void;
  onRemove: (deleteLocalData: boolean) => void;
  onRelinkAudio?: () => void;
  onRetryPersist?: () => void;
  onReloadFromDb?: () => void;
  onOverwriteDb?: () => void;
  isDragging?: boolean;
  isActive?: boolean;
  isStartingPlayback?: boolean;
  playbackError?: string | null;
  actionFeedback?: string | null;
  selectedStemId?: string | null;
  onSelectSong?: () => void;
  onSelectStem?: (stemId: string) => void;
  onToggleMute?: () => void;
  onToggleStemMute?: (stemId: string) => void;
  onToggleStemSolo?: (stemId: string) => void;
  onDragStartHandle?: (event: React.DragEvent<HTMLButtonElement>) => void;
  onDragEndHandle?: (event: React.DragEvent<HTMLButtonElement>) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
};

function GripVerticalIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      style={{ display: "block" }}
    >
      <circle cx="9" cy="5" r="1.5" />
      <circle cx="9" cy="12" r="1.5" />
      <circle cx="9" cy="19" r="1.5" />
      <circle cx="15" cy="5" r="1.5" />
      <circle cx="15" cy="12" r="1.5" />
      <circle cx="15" cy="19" r="1.5" />
    </svg>
  );
}

function SplitStemsIcon({ refresh = false }: { refresh?: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12h5" />
      <path d="M8 12c2.5 0 3-6 6-6h7" />
      <path d="M8 12h13" />
      <path d="M8 12c2.5 0 3 6 6 6h7" />
      {refresh && <path d="M18 3l3 3-3 3" />}
    </svg>
  );
}

function SourceModeIcon({ stems }: { stems: boolean }) {
  if (stems) {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <line x1="4" y1="6" x2="20" y2="6" />
        <circle cx="9" cy="6" r="2" fill="currentColor" />
        <line x1="4" y1="12" x2="20" y2="12" />
        <circle cx="15" cy="12" r="2" fill="currentColor" />
        <line x1="4" y1="18" x2="20" y2="18" />
        <circle cx="11" cy="18" r="2" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12h3l2-5 3 10 3-8 2 5 2-2h3" />
    </svg>
  );
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ transform: expanded ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 140ms ease" }}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function LoopIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="17 1 21 5 17 9" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline points="7 23 3 19 7 15" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  );
}

const STATUS_COLOR = { stopped: "var(--muted)", playing: "#22c55e", paused: "#f59e0b" };
const STATUS_LABEL = { stopped: "停止", playing: "播放中", paused: "暫停" };
const PERSISTENCE_BADGE = {
  saving: { label: "儲存中…", tone: "is-saving" },
  saved: { label: "已保存在此裝置", tone: "is-saved" },
  error: { label: "儲存失敗", tone: "is-error" },
  restoring: { label: "正在恢復歌曲…", tone: "is-saving" },
  missing_audio: { label: "需重新匯入音檔", tone: "is-warn" },
  conflict: { label: "分頁設定衝突", tone: "is-warn" },
  unsaved: { label: "僅此工作階段", tone: "is-warn" },
} as const;
const MANUAL_RATE_MIN = 0.25;
const MANUAL_RATE_MAX = 4;
const MANUAL_RATE_STEP = 0.05;

function clampManualRate(value: number) {
  return Math.max(MANUAL_RATE_MIN, Math.min(MANUAL_RATE_MAX, value));
}

export const SongCard = memo(function SongCard(props: Props) {
  const { song } = props;
  const [selectedMode, setSelectedMode] = useState<StemSeparationMode | null>(null);
  const mode: StemSeparationMode = selectedMode ?? song.separationMode ?? "four_stem";
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [stemsOpen, setStemsOpen] = useState(true);
  const prevSeparationStatusRef = useRef(song.separationStatus);

  useEffect(() => {
    if (prevSeparationStatusRef.current !== "completed" && song.separationStatus === "completed" && song.stemIds.length > 0) {
      setStemsOpen(true);
    }
    prevSeparationStatusRef.current = song.separationStatus;
  }, [song.separationStatus, song.stemIds.length]);
  const audioUnavailable = song.persistenceStatus === "restoring" || song.persistenceStatus === "missing_audio";
  const persistenceInfo = song.persistenceStatus ? PERSISTENCE_BADGE[song.persistenceStatus] : null;
  const rate = getEffectivePlaybackRate(song);
  const coarseRate = song.tempoMode === "target-bpm"
    ? song.targetBpm / Math.max(1, song.originalBpm)
    : song.manualRate;
  const masterVolumePct = Math.round(song.masterVolume * 100);
  const manualRatePct = ((song.manualRate - MANUAL_RATE_MIN) / (MANUAL_RATE_MAX - MANUAL_RATE_MIN)) * 100;
  const fineOffsetPct = ((song.fineRateOffset + 0.05) / 0.1) * 100;
  const isDefaultKey = song.keyShiftSemitones === 0;
  const isDefaultSpeed = Math.abs(rate - 1) < 0.0005 && song.fineRateOffset === 0 && song.targetBpm === song.originalBpm && song.manualRate === 1;
  const isDefaultMix = isDefaultKey && isDefaultSpeed;
  const setManualRate = (value: number) => props.onChange({
    manualRate: clampManualRate(value),
    tempoMode: "manual-rate",
  });

  return (
    <article
      data-song-id={song.id}
      className={`card song-card${props.isActive ? " is-active" : ""}`}
      style={{
        border: song.selected ? "1.5px solid var(--accent)" : undefined,
      }}
      onPointerDown={() => props.onSelectSong?.()}
      onFocusCapture={() => props.onSelectSong?.()}
    >
      <div className="song-card-handle-col">
        <button
          type="button"
          className={`song-drag-handle${props.isDragging ? " is-dragging" : ""}`}
          draggable
          onDragStart={props.onDragStartHandle}
          onDragEnd={props.onDragEndHandle}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp") {
              event.preventDefault();
              props.onMoveUp?.();
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              props.onMoveDown?.();
            }
          }}
          aria-label={`拖曳以重新排序 ${song.name}`}
          title="拖曳以重新排序歌曲（或使用方向鍵上下移動）"
        >
          <GripVerticalIcon />
        </button>
      </div>

      <div className="song-card-body grid" style={{ gap: 14 }}>
        <div className="row" style={{ justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div className="row" style={{ gap: 10 }}>
          <input
            className="song-select"
            type="checkbox"
            aria-label={`選取 ${song.name}`}
            checked={song.selected}
            onChange={(event) => props.onChange({ selected: event.target.checked })}
          />
          <div>
            <strong style={{ display: "block", fontSize: 16 }}>{song.name}</strong>
            <span className="small" style={{ opacity: 0.5 }}>{song.fileName}</span>
          </div>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {props.isActive && <span className="song-focus-pill">焦點中</span>}
          {song.muted && <span className="song-muted-pill">已靜音</span>}
          {persistenceInfo && (
            <span
              className={`song-storage-pill ${persistenceInfo.tone}`}
              title={song.persistenceMessage || persistenceInfo.label}
            >
              {persistenceInfo.label}
            </span>
          )}
          <span className="small" style={{ color: STATUS_COLOR[song.status] }}>● {STATUS_LABEL[song.status]}</span>
          <IconActionButton
            icon={<ChevronIcon expanded={!props.collapsed} />}
            label={props.collapsed ? "展開歌曲" : "收合歌曲"}
            className="song-card-action is-compact"
            onClick={props.onToggleCollapse}
          />
          <IconActionButton
            icon="🗑"
            label="移除歌曲"
            danger
            expanded={confirmingRemove}
            className="song-card-action is-compact"
            onClick={() => setConfirmingRemove((value) => !value)}
          />
        </div>
      </div>

      {confirmingRemove && (
        <div role="region" aria-label={`移除 ${song.name} 確認`} className="card-warning-banner">
          <div className="grid" style={{ gap: 4 }}>
            <strong>從清單移除「{song.name}」？</strong>
            <span className="small" style={{ opacity: 0.85 }}>若其他歌曲仍共用同一音檔，系統會自動保留共用音檔與分離快取。</span>
          </div>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn mixer-button"
              style={{ padding: "5px 10px", fontSize: 12 }}
              onClick={() => {
                setConfirmingRemove(false);
                props.onRemove(false);
              }}
            >
              僅移除歌曲（保留本機檔案）
            </button>
            <button
              type="button"
              className="btn mixer-button"
              style={{ padding: "5px 10px", fontSize: 12, color: "#fca5a5", borderColor: "rgba(248, 113, 113, 0.45)" }}
              onClick={() => {
                setConfirmingRemove(false);
                props.onRemove(true);
              }}
            >
              一併刪除本機音檔與快取
            </button>
            <button
              type="button"
              className="btn mixer-button"
              style={{ padding: "5px 10px", fontSize: 12 }}
              onClick={() => setConfirmingRemove(false)}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {song.persistenceStatus === "missing_audio" && (
        <div role="alert" className="card-error-banner">
          <span>{song.persistenceMessage || "找不到本機原始音檔或檔案已損壞，請重新匯入。"}</span>
          {props.onRelinkAudio && (
            <button
              type="button"
              className="btn mixer-button"
              style={{ padding: "4px 10px", fontSize: 12 }}
              onClick={props.onRelinkAudio}
            >
              重新選取音檔
            </button>
          )}
        </div>
      )}

      {song.persistenceStatus === "error" && song.persistenceMessage && (
        <div role="alert" className="card-warning-banner">
          <span>{song.persistenceMessage}</span>
          {props.onRetryPersist && (
            <button
              type="button"
              className="btn mixer-button"
              style={{ padding: "4px 10px", fontSize: 12 }}
              onClick={props.onRetryPersist}
            >
              ↻ 重試保存
            </button>
          )}
        </div>
      )}

      {(song.hasConflict || song.persistenceStatus === "conflict") && (
        <div role="alert" className="card-warning-banner">
          <span>{song.persistenceMessage || "偵測到其他分頁修改了此歌曲，請選擇要載入最新設定或覆蓋。"}</span>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {props.onReloadFromDb && (
              <button
                type="button"
                className="btn mixer-button"
                style={{ padding: "4px 10px", fontSize: 12 }}
                onClick={props.onReloadFromDb}
              >
                載入其他分頁設定
              </button>
            )}
            {props.onOverwriteDb && (
              <button
                type="button"
                className="btn mixer-button"
                style={{ padding: "4px 10px", fontSize: 12 }}
                onClick={props.onOverwriteDb}
              >
                保留此分頁並覆蓋
              </button>
            )}
          </div>
        </div>
      )}

      {!props.collapsed && <>
        <TrackPlayhead playheadSec={song.playheadSec} durationSec={song.durationSec} onChange={props.onSeek} onSelect={props.onSelectSong} />

        <div className="row song-transport" style={{ gap: 6, flexWrap: "wrap", minWidth: 0 }}>
          <AdaptiveActionRow
            items={[
              {
                key: "play",
                label: song.status === "playing" ? "暫停" : "播放",
                shortcut: "Space",
                pressed: song.status === "playing",
                disabled: props.isStartingPlayback || audioUnavailable,
                disabledReason: audioUnavailable
                  ? (song.persistenceStatus === "restoring" ? "正在恢復音檔，請稍候" : "缺少本機原始音檔，請先重新選取音檔")
                  : (props.isStartingPlayback ? "音訊引擎啟動中，請稍候" : undefined),
                onSelect: props.onPlayPause,
                renderInline: () => (
                  <IconActionButton
                    icon={props.isStartingPlayback ? <span className="mixer-spinner" aria-hidden="true" /> : song.status === "playing" ? "⏸" : "▶"}
                    label={song.status === "playing" ? "暫停" : "播放"}
                    shortcut="Space"
                    pressed={song.status === "playing"}
                    primary={song.status === "playing"}
                    busy={props.isStartingPlayback}
                    disabled={props.isStartingPlayback || audioUnavailable}
                    disabledReason={
                      audioUnavailable
                        ? (song.persistenceStatus === "restoring" ? "正在恢復音檔，請稍候" : "缺少本機原始音檔，請先重新選取音檔")
                        : (props.isStartingPlayback ? "音訊引擎啟動中，請稍候" : undefined)
                    }
                    onClick={props.onPlayPause}
                  />
                ),
              },
              {
                key: "stop",
                label: "停止",
                disabled: song.status === "stopped" || props.isStartingPlayback,
                disabledReason: song.status === "stopped" ? "歌曲目前已處於停止狀態" : undefined,
                onSelect: props.onStop,
                renderInline: () => (
                  <IconActionButton
                    icon="■"
                    label="停止"
                    disabled={song.status === "stopped" || props.isStartingPlayback}
                    disabledReason={song.status === "stopped" ? "歌曲目前已處於停止狀態" : undefined}
                    onClick={props.onStop}
                  />
                ),
              },
              {
                key: "loop",
                label: song.loop ? "循環播放中（切換單次）" : "單次播放（開啟循環）",
                shortcut: "Alt+L",
                pressed: song.loop,
                onSelect: () => props.onChange({ loop: !song.loop }),
                renderInline: () => (
                  <IconActionButton
                    icon={<LoopIcon />}
                    label={song.loop ? "循環播放中（點擊切換單次）" : "單次播放（點擊開啟循環）"}
                    shortcut="Alt+L"
                    pressed={song.loop}
                    primary={song.loop}
                    onClick={() => props.onChange({ loop: !song.loop })}
                  />
                ),
              },
              {
                key: "mute",
                label: song.muted ? "取消整首靜音" : "整首靜音",
                shortcut: "Alt+M",
                pressed: Boolean(song.muted),
                onSelect: () => (props.onToggleMute ? props.onToggleMute() : props.onChange({ muted: !song.muted })),
                renderInline: () => (
                  <IconActionButton
                    icon={song.muted ? "🔇" : "🔊"}
                    label={`${song.name} 整首靜音`}
                    shortcut="Alt+M"
                    pressed={Boolean(song.muted)}
                    primary={Boolean(song.muted)}
                    onClick={() => (props.onToggleMute ? props.onToggleMute() : props.onChange({ muted: !song.muted }))}
                  />
                ),
              },
              {
                key: "reset-mix",
                label: "恢復原始速度與 Key",
                shortcut: "Alt+C",
                disabled: isDefaultMix,
                disabledReason: isDefaultMix ? "目前已是原始速度與 Key" : undefined,
                onSelect: () => props.onChange({ targetBpm: song.originalBpm, keyShiftSemitones: 0, tempoMode: "target-bpm", manualRate: 1, fineRateOffset: 0 }),
                renderInline: () => (
                  <IconActionButton
                    icon="↺"
                    label="恢復原始速度與 Key"
                    shortcut="Alt+C"
                    disabled={isDefaultMix}
                    disabledReason={isDefaultMix ? "目前已是原始速度與 Key" : undefined}
                    onClick={() => props.onChange({ targetBpm: song.originalBpm, keyShiftSemitones: 0, tempoMode: "target-bpm", manualRate: 1, fineRateOffset: 0 })}
                  />
                ),
              },
            ]}
          />
          <label className="row song-volume" style={{ gap: 6, marginLeft: 6, flexWrap: "nowrap", flex: "0 1 auto" }}>
            <span className="small" style={{ whiteSpace: "nowrap" }}>音量</span>
            <input
              aria-label={`${song.name} 主音量`}
              className="mixer-range is-volume"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={song.masterVolume}
              style={{ width: "clamp(68px, 16vw, 110px)", "--range-progress": `${masterVolumePct}%` } as CSSProperties}
              onChange={(event) => props.onChange({ masterVolume: Number(event.target.value) })}
            />
            <span className="small" style={{ width: 34, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{masterVolumePct}%</span>
          </label>
        </div>

        {props.playbackError && (
          <div role="alert" className="card-error-banner">
            <span>{props.playbackError}</span>
          </div>
        )}

        {props.actionFeedback && (
          <div role="status" aria-live="polite" className="card-action-feedback">
            {props.actionFeedback}
          </div>
        )}

        <div className="song-pitch-tempo-grid">
          <div className="grid" style={{ gap: 6 }}>
            <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
              <span className="small">升降 Key</span>
              <strong style={{ color: "var(--accent)", fontSize: 13, fontVariantNumeric: "tabular-nums" }}>
                {rate.toFixed(3)}× · {song.keyShiftSemitones >= 0 ? "+" : ""}{song.keyShiftSemitones}st
              </strong>
            </div>
            <div className="row" style={{ gap: 6, flexWrap: "nowrap", alignItems: "center" }}>
              <button type="button" aria-label="降低 Key 一個半音" className="btn mixer-button key-stepper" style={{ padding: "6px 9px" }} onClick={() => props.onChange({ keyShiftSemitones: Math.max(-12, song.keyShiftSemitones - 1) })}>−</button>
              <input aria-label="升降 Key 半音數" className="input" type="number" min={-12} max={12} value={song.keyShiftSemitones} style={{ width: 54, textAlign: "center" }} onChange={(event) => props.onChange({ keyShiftSemitones: Math.max(-12, Math.min(12, Math.round(Number(event.target.value)))) })} />
              <button type="button" aria-label="提高 Key 一個半音" className="btn mixer-button key-stepper" style={{ padding: "6px 9px" }} onClick={() => props.onChange({ keyShiftSemitones: Math.min(12, song.keyShiftSemitones + 1) })}>+</button>
              <IconActionButton
                icon="↺"
                label="恢復原始 Key (0)"
                shortcut="Alt+X"
                disabled={isDefaultKey}
                disabledReason={isDefaultKey ? "目前已是原始 Key (0)" : undefined}
                className="is-compact"
                onClick={() => props.onChange({ keyShiftSemitones: 0 })}
              />
            </div>
          </div>

          <div className="song-tempo-sliders">
            <div className="grid manual-rate-control" style={{ gap: 6 }}>
              <div className="row" style={{ justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                <span className="small">播放倍率{song.tempoMode === "manual-rate" ? "（目前使用）" : ""}</span>
                <datalist id={`song-rates-${song.id}`}>
                  {song.savedRates.map((savedRate) => <option key={savedRate} value={savedRate.toFixed(3)} />)}
                </datalist>
                <div className="row manual-rate-input" style={{ gap: 6, flexWrap: "nowrap", alignItems: "center" }}>
                  <button type="button" aria-label={`降低倍率 ${MANUAL_RATE_STEP.toFixed(2)} 倍`} className="btn mixer-button rate-stepper" onClick={() => setManualRate(song.manualRate - MANUAL_RATE_STEP)}>−</button>
                  <input aria-label="指定播放倍率" className="input" type="number" list={`song-rates-${song.id}`} min={MANUAL_RATE_MIN} max={MANUAL_RATE_MAX} step={0.01} value={song.manualRate.toFixed(3)} onChange={(event) => setManualRate(Number(event.target.value) || 1)} />
                  <button type="button" aria-label={`提高倍率 ${MANUAL_RATE_STEP.toFixed(2)} 倍`} className="btn mixer-button rate-stepper" onClick={() => setManualRate(song.manualRate + MANUAL_RATE_STEP)}>+</button>
                  <IconActionButton
                    icon={song.savedRates.some((value) => Math.abs(value - rate) < 0.0001) ? "★" : "☆"}
                    label={song.savedRates.some((value) => Math.abs(value - rate) < 0.0001) ? "移除已儲存倍率" : "儲存目前倍率"}
                    pressed={song.savedRates.some((value) => Math.abs(value - rate) < 0.0001)}
                    primary={song.savedRates.some((value) => Math.abs(value - rate) < 0.0001)}
                    className="is-compact"
                    onClick={() => {
                      const savedRate = Math.round(rate * 1000) / 1000;
                      const exists = song.savedRates.some((value) => Math.abs(value - savedRate) < 0.0001);
                      props.onChange({
                        savedRates: exists
                          ? song.savedRates.filter((value) => value === 1 || Math.abs(value - savedRate) >= 0.0001)
                          : [...song.savedRates, savedRate].sort((a, b) => a - b),
                      });
                    }}
                  />
                  <IconActionButton
                    icon="↺"
                    label="恢復原始速度 (1.000×)"
                    shortcut="Alt+Z"
                    disabled={isDefaultSpeed}
                    disabledReason={isDefaultSpeed ? "目前已是原始速度 (1.000×)" : undefined}
                    className="is-compact"
                    onClick={() => props.onChange({ targetBpm: song.originalBpm, tempoMode: "target-bpm", manualRate: 1, fineRateOffset: 0 })}
                  />
                </div>
              </div>
              <input
                aria-label="倍率粗調拉桿"
                className="manual-rate-slider mixer-range is-speed"
                type="range"
                min={MANUAL_RATE_MIN}
                max={MANUAL_RATE_MAX}
                step={MANUAL_RATE_STEP}
                value={song.manualRate}
                style={{ "--range-progress": `${manualRatePct}%` } as CSSProperties}
                onChange={(event) => setManualRate(Number(event.target.value))}
              />
            </div>

            <div className="grid" style={{ gap: 6 }}>
              <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
                <span className="small">倍率微調 ±0.05</span>
                <span className="small" style={{ opacity: 0.75, fontVariantNumeric: "tabular-nums" }}>
                  {coarseRate.toFixed(3)}× {song.fineRateOffset >= 0 ? "+" : ""}{song.fineRateOffset.toFixed(3)}
                </span>
              </div>
              <input
                aria-label={`${song.name} 倍率微調`}
                className="mixer-range is-speed"
                type="range"
                min={-0.05}
                max={0.05}
                step={0.001}
                value={song.fineRateOffset}
                style={{ "--range-progress": `${fineOffsetPct}%` } as CSSProperties}
                onChange={(event) => props.onChange({ fineRateOffset: Number(event.target.value) })}
              />
            </div>
          </div>
        </div>

        <details className="song-advanced-tempo">
          <summary>
            ▸ 進階 BPM 設定（{song.originalBpm} → {song.targetBpm} BPM{song.tempoMode === "target-bpm" ? " · 目前使用" : ""}）
          </summary>
          <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "end", paddingTop: 10 }}>
            <label className="grid" style={{ gap: 4 }}>
              <span className="small">原始 BPM</span>
              <input aria-label="原始 BPM" className="input" type="number" min={20} max={300} value={song.originalBpm} style={{ width: 82 }} onChange={(event) => props.onChange({ originalBpm: Math.max(20, Math.min(300, Number(event.target.value) || 120)) })} />
            </label>
            <label className="grid" style={{ gap: 4 }}>
              <span className="small">目標 BPM{song.tempoMode === "target-bpm" ? " ●" : ""}</span>
              <input aria-label="目標 BPM" className="input" type="number" min={20} max={300} value={song.targetBpm} style={{ width: 82 }} onChange={(event) => props.onChange({ targetBpm: Math.max(20, Math.min(300, Number(event.target.value) || song.originalBpm)), tempoMode: "target-bpm", fineRateOffset: 0 })} />
            </label>
            {song.tempoMode === "manual-rate" && (
              <button type="button" className="btn mixer-button" style={{ padding: "6px 10px", fontSize: 12 }} onClick={() => props.onChange({ tempoMode: "target-bpm", fineRateOffset: 0 })}>
                改用目標 BPM
              </button>
            )}
          </div>
        </details>

        <section className="grid" style={{ gap: 10, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
          <div className="row" style={{ gap: 8, flexWrap: "nowrap", minWidth: 0 }}>
            <strong style={{ flex: "0 0 auto" }}>音源</strong>
            <select className="input" aria-label="分離軌數模式" value={mode} disabled={song.separationStatus === "processing"} style={{ flex: "0 0 auto" }} onChange={(event) => setSelectedMode(event.target.value as StemSeparationMode)}>
              <option value="two_stem">2 Stem</option>
              <option value="four_stem">4 Stem</option>
            </select>
            <AdaptiveActionRow
              items={[
                {
                  key: "separate",
                  label: song.separationStatus === "processing" ? "分離中…" : song.separationStatus === "completed" ? "重新分離音源" : "分離音源",
                  disabled: song.separationStatus === "processing" || audioUnavailable,
                  disabledReason: song.separationStatus === "processing"
                    ? "正在進行音源分離，請勿重複送出"
                    : audioUnavailable
                      ? "請先等待恢復或重新選取原始音檔"
                      : undefined,
                  onSelect: () => props.onSeparate(mode),
                  renderInline: () => (
                    <IconActionButton
                      icon={
                        song.separationStatus === "processing"
                          ? <span className="mixer-spinner" aria-hidden="true" />
                          : <SplitStemsIcon refresh={song.separationStatus === "completed"} />
                      }
                      label={song.separationStatus === "processing" ? "分離中…" : song.separationStatus === "completed" ? "重新分離音源" : "分離音源"}
                      primary
                      busy={song.separationStatus === "processing"}
                      disabled={song.separationStatus === "processing" || audioUnavailable}
                      disabledReason={
                        song.separationStatus === "processing"
                          ? "正在進行音源分離，請勿重複送出"
                          : audioUnavailable
                            ? "請先等待恢復或重新選取原始音檔"
                            : undefined
                      }
                      className="is-compact"
                      onClick={() => props.onSeparate(mode)}
                    />
                  ),
                },
                ...(song.stemIds.length > 0
                  ? ([
                      {
                        key: "source-toggle",
                        label: song.playbackSource === "stems" ? "切換為原始混音" : "切換為分軌混音",
                        pressed: song.playbackSource === "stems",
                        onSelect: () => props.onSwitchSource(song.playbackSource === "stems" ? "original" : "stems"),
                        renderInline: () => (
                          <IconActionButton
                            icon={<SourceModeIcon stems={song.playbackSource === "stems"} />}
                            label={song.playbackSource === "stems" ? "目前：分軌混音（點擊切換原始混音）" : "目前：原始混音（點擊切換分軌混音）"}
                            pressed={song.playbackSource === "stems"}
                            primary={song.playbackSource === "stems"}
                            className="is-compact"
                            onClick={() => props.onSwitchSource(song.playbackSource === "stems" ? "original" : "stems")}
                          />
                        ),
                      },
                      {
                        key: "clear-cache",
                        label: song.cacheKey ? "清除此歌分離快取" : "目前已無本機快取",
                        disabled: !song.cacheKey,
                        disabledReason: !song.cacheKey ? "目前已無本機快取" : undefined,
                        onSelect: props.onClearSongCache,
                        renderInline: () => (
                          <IconActionButton
                            icon="🧹"
                            label={song.cacheKey ? "清除此歌分離快取" : "目前已無本機快取"}
                            disabled={!song.cacheKey}
                            disabledReason={!song.cacheKey ? "目前已無本機快取" : undefined}
                            className="is-compact"
                            onClick={props.onClearSongCache}
                          />
                        ),
                      },
                      {
                        key: "toggle-stems",
                        label: stemsOpen ? "收合分軌拉桿" : `展開分軌拉桿（${song.stemChannels.length} 軌）`,
                        pressed: stemsOpen,
                        onSelect: () => setStemsOpen((value) => !value),
                        renderInline: () => (
                          <IconActionButton
                            icon={<ChevronIcon expanded={stemsOpen} />}
                            label={stemsOpen ? "收合分軌拉桿" : `展開分軌拉桿（${song.stemChannels.length} 軌）`}
                            expanded={stemsOpen}
                            className="is-compact"
                            onClick={() => setStemsOpen((value) => !value)}
                          />
                        ),
                      },
                    ] satisfies AdaptiveActionItem[])
                  : []),
              ]}
            />
          </div>
          {song.separationStatus === "processing" && (() => {
            const hasDeterminate = Number.isFinite(song.separationProgress) && song.separationProgress > 0 && song.separationProgress < 1;
            return (
              <div className="grid" style={{ gap: 6 }}>
                <div
                  role="progressbar"
                  aria-label="音源分離進度"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={hasDeterminate ? Math.round(song.separationProgress * 100) : undefined}
                  className={`mixer-progress-track${hasDeterminate ? "" : " is-indeterminate"}`}
                >
                  <div
                    className="mixer-progress-fill"
                    style={hasDeterminate ? { width: `${Math.round(song.separationProgress * 100)}%` } : undefined}
                  />
                </div>
                <span className="small">
                  {song.separationMessage || "處理中…"}
                  {hasDeterminate ? ` (${Math.round(song.separationProgress * 100)}%)` : ""}
                </span>
              </div>
            );
          })()}
          {song.separationStatus === "completed" && song.separationMessage && (
            <span className="small" style={{ color: "#34d399" }}>✓ {song.separationMessage}</span>
          )}
          {song.separationStatus === "failed" && (
            <div role="alert" className="card-error-banner">
              <span>{song.separationMessage}</span>
              <button type="button" className="btn mixer-button" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => props.onSeparate(mode)}>
                ↻ 重試分離
              </button>
            </div>
          )}
          {song.stemIds.length > 0 && stemsOpen && (
            <StemMixer
              channels={song.stemChannels}
              selectedStemId={props.selectedStemId}
              onSelectStem={props.onSelectStem}
              onToggleMute={props.onToggleStemMute}
              onToggleSolo={props.onToggleStemSolo}
              onChange={props.onStemChange}
              onDownload={props.onDownloadStem}
            />
          )}
          <details className="playback-note">
            <summary>播放同步說明</summary>
            <span className="small">SoundTouch 仍使用舊式 ScriptProcessorNode；同歌分軌共用 AudioContext、歌曲時間軸與單次排程，但目前不宣稱樣本級同步。</span>
          </details>
        </section>
      </>}
      </div>
    </article>
  );
}, (prev, next) => (
  prev.song === next.song
  && prev.collapsed === next.collapsed
  && prev.isDragging === next.isDragging
  && prev.isActive === next.isActive
  && prev.isStartingPlayback === next.isStartingPlayback
  && prev.playbackError === next.playbackError
  && prev.actionFeedback === next.actionFeedback
  && prev.selectedStemId === next.selectedStemId
));
