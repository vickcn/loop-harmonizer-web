"use client";

import type { StemChannel } from "@/lib/band/bandTypes";

const STEM_LABELS: Record<string, string> = {
  vocals: "Vocals／人聲",
  instrumental: "Instrumental／伴奏",
  drums: "Drums／鼓組",
  bass: "Bass／貝斯",
  other: "Other／其他",
};

type Props = {
  channels: StemChannel[];
  onChange: (id: string, patch: Partial<StemChannel>) => void;
  onDownload: (id: string) => void;
};

export function StemMixer({ channels, onChange, onDownload }: Props) {
  return (
    <div className="grid" style={{ gap: 8 }}>
      {channels.map((channel) => (
        <div
          key={channel.id}
          className="row"
          style={{
            gap: 10,
            padding: "9px 10px",
            border: "1px solid var(--line)",
            borderRadius: 10,
            flexWrap: "wrap",
            opacity: channel.muted ? 0.55 : 1,
          }}
        >
          <strong style={{ minWidth: 145, fontSize: 13 }}>{STEM_LABELS[channel.stemType] ?? channel.stemType}</strong>
          <input
            aria-label={`${channel.stemType} 音量`}
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={channel.volume}
            style={{ flex: "1 1 120px" }}
            onChange={(event) => onChange(channel.id, { volume: Number(event.target.value) })}
          />
          <span className="small" style={{ width: 38, textAlign: "right" }}>{Math.round(channel.volume * 100)}%</span>
          <button
            className={`btn${channel.muted ? " primary" : ""}`}
            style={{ padding: "5px 9px", fontSize: 12 }}
            onClick={() => onChange(channel.id, { muted: !channel.muted })}
          >
            Mute
          </button>
          <button
            className={`btn${channel.solo ? " primary" : ""}`}
            style={{ padding: "5px 9px", fontSize: 12 }}
            onClick={() => onChange(channel.id, { solo: !channel.solo })}
          >
            Solo
          </button>
          <button className="btn" style={{ padding: "5px 9px", fontSize: 12 }} onClick={() => onDownload(channel.id)}>
            ↓ WAV
          </button>
        </div>
      ))}
    </div>
  );
}
