"use client";

import { PointerEvent, useMemo, useRef, useState } from "react";
import { SongTimeline, TempoAnchor } from "@/lib/types";
import { getSectionAtBar, getTimelineBpmAtBar, makeTempoSegmentsFromAnchors } from "@/lib/timeline";

type Props = {
  timeline: SongTimeline;
  currentBar: number;
  onTimelineChange: (timeline: SongTimeline) => void;
};

const WIDTH = 980;
const SECTION_H = 74;
const TEMPO_H = 230;
const BPM_MIN = 80;
const BPM_MAX = 180;

export function TimelineEditor({ timeline, currentBar, onTimelineChange }: Props) {
  const [dragId, setDragId] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const sectionTypeMap = useMemo(() => new Map(timeline.sectionTypes.map((t) => [t.id, t])), [timeline.sectionTypes]);

  const barToX = (bar: number) => ((bar - 1) / (timeline.totalBars - 1)) * WIDTH;
  const xToBar = (x: number) => Math.round((x / WIDTH) * (timeline.totalBars - 1) + 1);
  const bpmToY = (bpm: number) => TEMPO_H - ((bpm - BPM_MIN) / (BPM_MAX - BPM_MIN)) * TEMPO_H;
  const yToBpm = (y: number) => Math.round(BPM_MIN + ((TEMPO_H - y) / TEMPO_H) * (BPM_MAX - BPM_MIN));

  const pointerToLocal = (event: PointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(WIDTH, event.clientX - rect.left)),
      y: Math.max(0, Math.min(TEMPO_H, event.clientY - rect.top - SECTION_H))
    };
  };

  const updateAnchor = (id: string, patch: Partial<TempoAnchor>) => {
    const anchors = timeline.tempoAnchors
      .map((a) => (a.id === id ? { ...a, ...patch } : a))
      .sort((a, b) => a.bar - b.bar);
    const next = { ...timeline, tempoAnchors: anchors };
    onTimelineChange({ ...next, tempoSegments: makeTempoSegmentsFromAnchors(next) });
  };

  const removeAnchor = (id: string) => {
    const anchors = timeline.tempoAnchors.filter((a) => a.id !== id).sort((a, b) => a.bar - b.bar);
    const next = { ...timeline, tempoAnchors: anchors };
    onTimelineChange({ ...next, tempoSegments: makeTempoSegmentsFromAnchors(next) });
  };

  const addAnchor = (event: PointerEvent<SVGSVGElement>) => {
    if ((event.target as Element).classList.contains("anchor-hit")) return;
    const { x, y } = pointerToLocal(event);
    const id = `ta_${Date.now()}`;
    const anchor = { id, bar: xToBar(x), bpm: yToBpm(y) };
    const next = { ...timeline, tempoAnchors: [...timeline.tempoAnchors, anchor].sort((a, b) => a.bar - b.bar) };
    onTimelineChange({ ...next, tempoSegments: makeTempoSegmentsFromAnchors(next) });
  };

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (!dragId) return;
    const { x, y } = pointerToLocal(event);
    updateAnchor(dragId, { bar: xToBar(x), bpm: yToBpm(y) });
  };

  const currentSection = getSectionAtBar(timeline, currentBar);
  const currentBpm = getTimelineBpmAtBar(timeline, currentBar);
  const sortedAnchors = [...timeline.tempoAnchors].sort((a, b) => a.bar - b.bar);
  const points = sortedAnchors.map((a) => `${barToX(a.bar)},${SECTION_H + bpmToY(a.bpm)}`).join(" ");

  return (
    <div className="card grid">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h2 style={{ margin: 0 }}>Timeline Editor</h2>
          <p className="small">點擊 Tempo 區可新增錨點；拖曳錨點可改 bar / BPM。段落名稱可重複，內部使用 section id。</p>
        </div>
        <div className="small">目前：{currentSection?.label ?? "--"}｜Bar {currentBar.toFixed(2)}｜{currentBpm.toFixed(1)} BPM</div>
      </div>

      <div style={{ overflowX: "auto" }}>
        <svg
          ref={svgRef}
          className="timeline"
          width={WIDTH}
          height={SECTION_H + TEMPO_H + 34}
          onDoubleClick={addAnchor}
          onPointerMove={onPointerMove}
          onPointerUp={() => setDragId(null)}
          onPointerCancel={() => setDragId(null)}
        >
          <rect x={0} y={0} width={WIDTH} height={SECTION_H + TEMPO_H} fill="#111520" rx={16} />

          {timeline.sections.map((section) => {
            const type = sectionTypeMap.get(section.typeId);
            const x = barToX(section.startBar);
            const w = Math.max(8, barToX(section.endBar) - x);
            return (
              <g key={section.id}>
                <rect x={x + 2} y={10} width={w - 4} height={46} rx={12} fill={type?.color ?? "#475569"} opacity={0.86} />
                <text x={x + w / 2} y={38} textAnchor="middle" fill="white" fontSize="13" fontWeight="700">{section.label}</text>
              </g>
            );
          })}

          {Array.from({ length: timeline.totalBars }, (_, i) => i + 1).map((bar) => {
            const x = barToX(bar);
            return (
              <g key={bar}>
                <line x1={x} y1={SECTION_H} x2={x} y2={SECTION_H + TEMPO_H} stroke={bar % 4 === 1 ? "#3b4256" : "#252b3a"} />
                {bar % 4 === 1 && <text x={x + 3} y={SECTION_H + TEMPO_H + 20} fill="#8f96aa" fontSize="11">{bar}</text>}
              </g>
            );
          })}

          {[80, 100, 120, 140, 160, 180].map((bpm) => {
            const y = SECTION_H + bpmToY(bpm);
            return (
              <g key={bpm}>
                <line x1={0} y1={y} x2={WIDTH} y2={y} stroke="#252b3a" />
                <text x={6} y={y - 4} fill="#8f96aa" fontSize="11">{bpm}</text>
              </g>
            );
          })}

          <polyline points={points} fill="none" stroke="#f8c471" strokeWidth={3} />

          {sortedAnchors.map((anchor) => {
            const x = barToX(anchor.bar);
            const y = SECTION_H + bpmToY(anchor.bpm);
            return (
              <g key={anchor.id}>
                <circle
                  className="anchor-hit"
                  cx={x}
                  cy={y}
                  r={18}
                  fill="transparent"
                  onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setDragId(anchor.id); }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    removeAnchor(anchor.id);
                  }}
                />
                <circle cx={x} cy={y} r={8} fill="#f8c471" stroke="white" strokeWidth={2} pointerEvents="none" />
                <text x={x + 10} y={y - 10} fill="#f4f4f5" fontSize="11" pointerEvents="none">{anchor.bpm} / B{anchor.bar}</text>
              </g>
            );
          })}

          <line x1={barToX(currentBar)} y1={0} x2={barToX(currentBar)} y2={SECTION_H + TEMPO_H} stroke="white" strokeWidth={2} opacity={0.9} />
        </svg>
      </div>
    </div>
  );
}
