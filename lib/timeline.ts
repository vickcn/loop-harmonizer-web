import { SongTimeline, TempoAnchor, TempoSegment } from "./types";

export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** tempoRatio 的分母：優先用使用者確認的 BPM，其次偵測值，最後 projectBpm */
export function getAudioBaseBpm(timeline: SongTimeline): number {
  return (
    timeline.audioSource.userConfirmedBpm ??
    timeline.audioSource.detectedBpm ??
    timeline.projectBpm
  );
}

export function getOrderedAnchors(timeline: SongTimeline): TempoAnchor[] {
  return [...timeline.tempoAnchors].sort((a, b) => a.bar - b.bar);
}

export function findTempoSegment(timeline: SongTimeline, bar: number): { from: TempoAnchor; to?: TempoAnchor; segment?: TempoSegment } | null {
  const anchors = getOrderedAnchors(timeline);
  if (anchors.length === 0) return null;
  if (bar <= anchors[0].bar) return { from: anchors[0] };

  for (let i = 0; i < anchors.length - 1; i++) {
    const from = anchors[i];
    const to = anchors[i + 1];
    if (bar >= from.bar && bar <= to.bar) {
      const segment = timeline.tempoSegments.find((s) => s.fromAnchorId === from.id && s.toAnchorId === to.id);
      return { from, to, segment };
    }
  }

  return { from: anchors[anchors.length - 1] };
}

export function getTimelineBpmAtBar(timeline: SongTimeline, bar: number): number {
  const found = findTempoSegment(timeline, bar);
  if (!found) return timeline.projectBpm;
  if (!found.to || !found.segment) return found.from.bpm;
  if (found.segment.mode === "hold") return found.from.bpm;

  const length = found.to.bar - found.from.bar;
  if (length <= 0) return found.to.bpm;
  const progress = clamp((bar - found.from.bar) / length, 0, 1);
  return found.from.bpm + (found.to.bpm - found.from.bpm) * progress;
}

export function getSectionAtBar(timeline: SongTimeline, bar: number) {
  return timeline.sections.find((section) => bar >= section.startBar && bar < section.endBar + 1);
}

export function makeTempoSegmentsFromAnchors(timeline: SongTimeline): TempoSegment[] {
  const anchors = getOrderedAnchors(timeline);
  return anchors.slice(0, -1).map((anchor, index) => {
    const existing = timeline.tempoSegments.find((seg) => seg.fromAnchorId === anchor.id && seg.toAnchorId === anchors[index + 1].id);
    return {
      id: existing?.id ?? `ts_${anchor.id}_${anchors[index + 1].id}`,
      fromAnchorId: anchor.id,
      toAnchorId: anchors[index + 1].id,
      mode: existing?.mode ?? "linear"
    };
  });
}

export const defaultTimeline: SongTimeline = {
  id: "song_demo",
  name: "Demo Loop",
  projectBpm: 120,
  audioSource: { id: "default", fileName: "" },
  totalBars: 32,
  timeSignature: { beatsPerBar: 4, beatUnit: 4 },
  sectionTypes: [
    { id: "stype_intro", name: "Intro", color: "#64748b" },
    { id: "stype_verse", name: "Verse", color: "#3b82f6" },
    { id: "stype_chorus", name: "Chorus", color: "#f97316" },
    { id: "stype_bridge", name: "Bridge", color: "#22c55e" }
  ],
  sections: [
    { id: "sec_001", typeId: "stype_intro", label: "Intro", startBar: 1, endBar: 4 },
    { id: "sec_002", typeId: "stype_verse", label: "Verse 1", startBar: 5, endBar: 12 },
    { id: "sec_003", typeId: "stype_chorus", label: "Chorus 1", startBar: 13, endBar: 20 },
    { id: "sec_004", typeId: "stype_verse", label: "Verse 2", startBar: 21, endBar: 28 },
    { id: "sec_005", typeId: "stype_chorus", label: "Chorus 2", startBar: 29, endBar: 32 }
  ],
  tempoAnchors: [
    { id: "ta_001", bar: 1, bpm: 120 },
    { id: "ta_002", bar: 8, bpm: 120 },
    { id: "ta_003", bar: 16, bpm: 128 },
    { id: "ta_004", bar: 24, bpm: 124 },
    { id: "ta_005", bar: 32, bpm: 132 }
  ],
  tempoSegments: [
    { id: "ts_001", fromAnchorId: "ta_001", toAnchorId: "ta_002", mode: "hold" },
    { id: "ts_002", fromAnchorId: "ta_002", toAnchorId: "ta_003", mode: "linear" },
    { id: "ts_003", fromAnchorId: "ta_003", toAnchorId: "ta_004", mode: "linear" },
    { id: "ts_004", fromAnchorId: "ta_004", toAnchorId: "ta_005", mode: "linear" }
  ]
};
