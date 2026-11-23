"use client";

import type { CSSProperties } from "react";
import { AdaptiveActionRow } from "./AdaptiveActionRow";
import { IconActionButton } from "./IconActionButton";
import type { StemChannel } from "@/lib/band/bandTypes";

const STEM_LABELS: Record<string, string> = {
  vocals: "人聲 Vocals",
  instrumental: "伴奏 Inst",
  drums: "鼓組 Drums",
  bass: "貝斯 Bass",
  other: "其他 Other",
};

type Props = {
  channel: StemChannel;
  selected: boolean;
  exportLocked: boolean;
  exportDisabledReason?: string;
  onSelect?: (id: string) => void;
  onToggleMute?: (id: string) => void;
  onToggleSolo?: (id: string) => void;
  onChange: (id: string, patch: Partial<StemChannel>) => void;
  onDownload: (id: string) => void;
};

/** 一條分軌就是一個可在桌機與觸控環境一致操作的 channel strip。 */
export function StemChannelStrip({
  channel,
  selected,
  exportLocked,
  exportDisabledReason,
  onSelect,
  onToggleMute,
  onToggleSolo,
  onChange,
  onDownload,
}: Props) {
  const label = STEM_LABELS[channel.stemType] ?? channel.stemType;
  const percent = Math.round(channel.volume * 100);
  const toggleMute = () => (onToggleMute ? onToggleMute(channel.id) : onChange(channel.id, { muted: !channel.muted }));
  const toggleSolo = () => (onToggleSolo ? onToggleSolo(channel.id) : onChange(channel.id, { solo: !channel.solo }));

  return (
    <div
      data-stem-id={channel.id}
      className={`row stem-row${selected ? " is-active" : ""}`}
      onPointerDownCapture={(event) => {
        event.stopPropagation();
        onSelect?.(channel.id);
      }}
      onFocusCapture={(event) => {
        event.stopPropagation();
        onSelect?.(channel.id);
      }}
      onClick={(event) => {
        event.stopPropagation();
        onSelect?.(channel.id);
      }}
      style={{ opacity: channel.muted ? 0.55 : 1 }}
    >
      <div className="stem-row-heading">
        <strong className="stem-row-label">{label}</strong>
        <span className="small stem-row-pct">{percent}%</span>
      </div>
      <input
        aria-label={`${label} 音量`}
        className="mixer-range is-volume stem-row-slider"
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={channel.volume}
        style={{ "--range-progress": `${percent}%` } as CSSProperties}
        onPointerDown={(event) => event.stopPropagation()}
        onPointerMove={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
        onChange={(event) => onChange(channel.id, { volume: Number(event.target.value) })}
      />
      <AdaptiveActionRow
        className="stem-row-actions"
        items={[
          {
            key: "mute",
            label: `${label} Mute`,
            shortcut: "Alt+M",
            pressed: channel.muted,
            onSelect: toggleMute,
            renderInline: () => (
              <IconActionButton icon={channel.muted ? "✕" : "M"} label={`${label} Mute`} shortcut="Alt+M" pressed={channel.muted} primary={channel.muted} className="is-compact" onClick={toggleMute} />
            ),
          },
          {
            key: "solo",
            label: `${label} Solo`,
            shortcut: "Alt+K",
            pressed: channel.solo,
            onSelect: toggleSolo,
            renderInline: () => (
              <IconActionButton icon={channel.solo ? "★" : "S"} label={`${label} Solo`} shortcut="Alt+K" pressed={channel.solo} primary={channel.solo} className="is-compact" onClick={toggleSolo} />
            ),
          },
          {
            key: "download",
            label: `下載 ${label} WAV`,
            disabled: exportLocked,
            disabledReason: exportLocked ? exportDisabledReason : undefined,
            onSelect: () => onDownload(channel.id),
            renderInline: () => (
              <IconActionButton icon="↓" label={`下載 ${label} WAV`} disabled={exportLocked} disabledReason={exportLocked ? exportDisabledReason : undefined} className="is-compact" onClick={() => onDownload(channel.id)} />
            ),
          },
        ]}
      />
    </div>
  );
}
