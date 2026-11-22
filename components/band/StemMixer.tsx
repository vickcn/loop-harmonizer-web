"use client";

import { memo, type CSSProperties } from "react";
import { IconActionButton } from "@/components/band/IconActionButton";
import { AdaptiveActionRow } from "@/components/band/AdaptiveActionRow";
import type { StemChannel } from "@/lib/band/bandTypes";

const STEM_LABELS: Record<string, string> = {
  vocals: "人聲 Vocals",
  instrumental: "伴奏 Inst",
  drums: "鼓組 Drums",
  bass: "貝斯 Bass",
  other: "其他 Other",
};

type Props = {
  channels: StemChannel[];
  selectedStemId?: string | null;
  exportLocked?: boolean;
  exportDisabledReason?: string;
  onSelectStem?: (id: string) => void;
  onToggleMute?: (id: string) => void;
  onToggleSolo?: (id: string) => void;
  onChange: (id: string, patch: Partial<StemChannel>) => void;
  onDownload: (id: string) => void;
};

export const StemMixer = memo(function StemMixer({
  channels,
  selectedStemId,
  exportLocked = false,
  exportDisabledReason,
  onSelectStem,
  onToggleMute,
  onToggleSolo,
  onChange,
  onDownload,
}: Props) {
  return (
    <div className="stem-mixer-grid">
      {channels.map((channel) => {
        const isSelected = selectedStemId === channel.id;
        const label = STEM_LABELS[channel.stemType] ?? channel.stemType;
        const percent = Math.round(channel.volume * 100);
        return (
          <div
            key={channel.id}
            data-stem-id={channel.id}
            className={`row stem-row${isSelected ? " is-active" : ""}`}
            onPointerDownCapture={(event) => {
              event.stopPropagation();
              onSelectStem?.(channel.id);
            }}
            onFocusCapture={(event) => {
              event.stopPropagation();
              onSelectStem?.(channel.id);
            }}
            onClick={(event) => {
              event.stopPropagation();
              onSelectStem?.(channel.id);
            }}
            style={{
              opacity: channel.muted ? 0.55 : 1,
            }}
          >
            <strong className="stem-row-label">{label}</strong>
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
            <span className="small stem-row-pct">{percent}%</span>
            <AdaptiveActionRow
              className="stem-row-actions"
              items={[
                {
                  key: "mute",
                  label: `${label} Mute`,
                  shortcut: "Alt+M",
                  pressed: channel.muted,
                  onSelect: () => (onToggleMute ? onToggleMute(channel.id) : onChange(channel.id, { muted: !channel.muted })),
                  renderInline: () => (
                    <IconActionButton
                      icon={channel.muted ? "✕" : "M"}
                      label={`${label} Mute`}
                      shortcut="Alt+M"
                      pressed={channel.muted}
                      primary={channel.muted}
                      className="is-compact"
                      onClick={() => (onToggleMute ? onToggleMute(channel.id) : onChange(channel.id, { muted: !channel.muted }))}
                    />
                  ),
                },
                {
                  key: "solo",
                  label: `${label} Solo`,
                  shortcut: "Alt+K",
                  pressed: channel.solo,
                  onSelect: () => (onToggleSolo ? onToggleSolo(channel.id) : onChange(channel.id, { solo: !channel.solo })),
                  renderInline: () => (
                    <IconActionButton
                      icon={channel.solo ? "★" : "S"}
                      label={`${label} Solo`}
                      shortcut="Alt+K"
                      pressed={channel.solo}
                      primary={channel.solo}
                      className="is-compact"
                      onClick={() => (onToggleSolo ? onToggleSolo(channel.id) : onChange(channel.id, { solo: !channel.solo }))}
                    />
                  ),
                },
                {
                  key: "download",
                  label: `下載 ${label} WAV`,
                  disabled: exportLocked,
                  disabledReason: exportLocked ? exportDisabledReason : undefined,
                  onSelect: () => onDownload(channel.id),
                  renderInline: () => (
                    <IconActionButton
                      icon="↓"
                      label={`下載 ${label} WAV`}
                      disabled={exportLocked}
                      disabledReason={exportLocked ? exportDisabledReason : undefined}
                      className="is-compact"
                      onClick={() => onDownload(channel.id)}
                    />
                  ),
                },
              ]}
            />
          </div>
        );
      })}
    </div>
  );
});
