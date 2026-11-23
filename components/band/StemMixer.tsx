"use client";

import { memo } from "react";
import { StemChannelStrip } from "@/components/band/StemChannelStrip";
import type { StemChannel } from "@/lib/band/bandTypes";

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
      {channels.map((channel) => (
        <StemChannelStrip
          key={channel.id}
          channel={channel}
          selected={selectedStemId === channel.id}
          exportLocked={exportLocked}
          exportDisabledReason={exportDisabledReason}
          onSelect={onSelectStem}
          onToggleMute={onToggleMute}
          onToggleSolo={onToggleSolo}
          onChange={onChange}
          onDownload={onDownload}
        />
      ))}
    </div>
  );
});
