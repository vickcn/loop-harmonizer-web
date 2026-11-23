"use client";

import { IconActionButton } from "./IconActionButton";
import { SongStatusIndicators } from "./SongStatusIndicators";
import type { StatusIndicatorItem } from "@/lib/band/songStatusIndicators";

type Props = {
  songName: string;
  fileName: string;
  selected: boolean;
  collapsed: boolean;
  statusLabel: string;
  statusColor: string;
  statusItems: readonly StatusIndicatorItem[];
  onSelect: (selected: boolean) => void;
  onToggleCollapse: () => void;
  onRemove: () => void;
};

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

/** 歌曲身分、狀態與卡片層級操作集中在一致的標頭。 */
export function SongCardHeader({
  songName,
  fileName,
  selected,
  collapsed,
  statusLabel,
  statusColor,
  statusItems,
  onSelect,
  onToggleCollapse,
  onRemove,
}: Props) {
  return (
    <header className="song-card-header">
      <div className="song-card-identity">
        <input
          className="song-select"
          type="checkbox"
          aria-label={`選取 ${songName}`}
          checked={selected}
          onPointerDown={(event) => event.stopPropagation()}
          onFocus={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => onSelect(event.target.checked)}
        />
        <div className="song-card-title-copy">
          <strong title={songName}>{songName}</strong>
          <span className="small" title={fileName}>{fileName}</span>
        </div>
      </div>
      <div className="song-card-header-meta">
        <div className="row song-card-badges" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <SongStatusIndicators items={statusItems} />
          <span className="small song-play-state" style={{ color: statusColor }}>● {statusLabel}</span>
        </div>
        <div className="song-card-header-actions">
          <IconActionButton icon={<ChevronIcon expanded={!collapsed} />} label={collapsed ? "展開歌曲" : "收合歌曲"} className="song-card-action is-compact" onClick={onToggleCollapse} />
          <IconActionButton icon="🗑" label="移除歌曲" danger className="song-card-action is-compact" onClick={onRemove} />
        </div>
      </div>
    </header>
  );
}
