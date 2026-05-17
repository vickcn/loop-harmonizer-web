"use client";

import { PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { SectionInstance, SongTimeline, TempoAnchor } from "@/lib/types";
import { getSectionAtBar, getTimelineBpmAtBar, makeTempoSegmentsFromAnchors } from "@/lib/timeline";

type Props = {
  timeline: SongTimeline;
  currentBar: number;
  isPlaying?: boolean;
  dimTempo?: boolean;
  activeSectionId?: string | null;
  onTimelineChange: (timeline: SongTimeline) => void;
  onCurrentBarChange?: (bar: number) => void;
  onSectionClick?: (sectionId: string) => void;
};

const MIN_WIDTH = 720;        // 手機橫滑用的最小寬度
const MAX_WIDTH = 1800;       // 桌機上限，避免拉太誇張
const SECTION_H = 74;
const TEMPO_H = 230;
const Y_SPAN_OPTIONS = [4, 8, 12, 16, 24];
const HANDLE_W = 8;

type SectionDrag =
  | { kind: "move"; id: string; origStart: number; origEnd: number; ptrX: number }
  | { kind: "resize-l"; id: string; origStart: number; ptrX: number }
  | { kind: "resize-r"; id: string; origEnd: number; ptrX: number }
  | null;

export function TimelineEditor({
  timeline,
  currentBar,
  isPlaying = false,
  dimTempo = false,
  activeSectionId = null,
  onTimelineChange,
  onCurrentBarChange,
  onSectionClick,
}: Props) {
  const [dragId, setDragId] = useState<string | null>(null);
  const dragIdRef = useRef<string | null>(null);
  const [playheadHover, setPlayheadHover] = useState(false);
  const [playheadDragging, setPlayheadDragging] = useState(false);
  const playheadDragRef = useRef(false);
  const scrubRafRef = useRef<number | null>(null);
  const scrubBarRef = useRef<number | null>(null);
  const [ySpan, setYSpan] = useState(4);
  const [editMode, setEditMode] = useState(false);
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);
  const [sectionDrag, setSectionDrag] = useState<SectionDrag>(null);
  const [copiedSection, setCopiedSection] = useState<SectionInstance | null>(null);
  const [width, setWidth] = useState<number>(MIN_WIDTH);
  // Background pan (mobile X scroll)
  const bgPanRef = useRef<{ startX: number; startScrollLeft: number } | null>(null);
  // Pinch-to-zoom for X axis (centered by current playhead bar)
  const pinchRef = useRef<{
    id0: number;
    id1: number;
    dist: number;
    startWidth: number;
    startScrollLeft: number;
    playBar: number;
  } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const sectionTypeMap = useMemo(() => new Map(timeline.sectionTypes.map((t) => [t.id, t])), [timeline.sectionTypes]);
  const centerBpm = timeline.projectBpm;
  const axisMin = centerBpm - ySpan;
  const axisMax = centerBpm + ySpan;
  const WIDTH = width;

  // 觀察容器寬度，桌機自動撐滿、手機保留 MIN_WIDTH 讓使用者橫滑
  useEffect(() => {
    if (!wrapperRef.current) return;
    const el = wrapperRef.current;
    const update = () => {
      const cw = el.clientWidth;
      // 容器若比 MIN 還窄就維持 MIN（觸發水平捲軸），否則 clamp 到 MAX
      const next = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, cw));
      setWidth(next);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const barToX = (bar: number) => ((bar - 1) / (timeline.totalBars - 1)) * WIDTH;
  const xToBar = (x: number) => Math.round((x / WIDTH) * (timeline.totalBars - 1) + 1);
  const xToBarCont = (x: number) => (x / WIDTH) * (timeline.totalBars - 1) + 1;
  const bpmToY = (bpm: number) => {
    const clamped = Math.max(axisMin, Math.min(axisMax, bpm));
    return TEMPO_H - ((clamped - axisMin) / (axisMax - axisMin)) * TEMPO_H;
  };
  const yToBpm = (y: number) => Math.round(axisMin + ((TEMPO_H - y) / TEMPO_H) * (axisMax - axisMin));
  const yTicks = useMemo(() => {
    const step = ySpan <= 8 ? 2 : ySpan <= 16 ? 4 : 8;
    return Array.from({ length: Math.floor((axisMax - axisMin) / step) + 1 }, (_, index) => axisMin + index * step);
  }, [axisMax, axisMin, ySpan]);
  const playheadX = barToX(currentBar);

  const scrubToPointer = (event: PointerEvent<SVGElement>) => {
    if (!onCurrentBarChange) return;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = Math.max(0, Math.min(WIDTH, event.clientX - rect.left));
    scrubBarRef.current = xToBarCont(x);
    if (scrubRafRef.current !== null) return;
    scrubRafRef.current = requestAnimationFrame(() => {
      scrubRafRef.current = null;
      if (scrubBarRef.current !== null) onCurrentBarChange(scrubBarRef.current);
    });
  };

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
    if (event.clientY - svgRef.current!.getBoundingClientRect().top < SECTION_H) return;
    const id = `ta_${Date.now()}`;
    const anchor = { id, bar: xToBar(x), bpm: yToBpm(y) };
    const next = { ...timeline, tempoAnchors: [...timeline.tempoAnchors, anchor].sort((a, b) => a.bar - b.bar) };
    onTimelineChange({ ...next, tempoSegments: makeTempoSegmentsFromAnchors(next) });
  };

  // Prevent sections from overlapping; gaps are allowed
  const clampSection = (id: string, startBar: number, endBar: number): { startBar: number; endBar: number } => {
    const others = timeline.sections.filter((s) => s.id !== id);
    let s = startBar;
    let e = endBar;
    for (const o of others) {
      // push right if overlapping from left
      if (s < o.endBar && e > o.startBar) {
        if (s < o.startBar) {
          e = Math.min(e, o.startBar);
        } else {
          s = Math.max(s, o.endBar);
        }
      }
    }
    s = Math.max(1, Math.round(s));
    e = Math.min(timeline.totalBars, Math.round(e));
    if (e <= s) e = s + 1;
    return { startBar: s, endBar: e };
  };

  const commitSection = (id: string, patch: Partial<SectionInstance>) => {
    const sections = timeline.sections.map((s) => (s.id === id ? { ...s, ...patch } : s));
    onTimelineChange({ ...timeline, sections });
  };

  const addSection = (clickX: number) => {
    const bar = xToBar(clickX);
    // Don't add if overlapping existing
    if (timeline.sections.some((s) => bar >= s.startBar && bar < s.endBar)) return;
    const typeId = timeline.sectionTypes[0]?.id ?? "verse";
    const id = `sec_${Date.now()}`;
    const newSection: SectionInstance = {
      id,
      typeId,
      label: "New",
      startBar: bar,
      endBar: Math.min(timeline.totalBars, bar + 8)
    };
    onTimelineChange({ ...timeline, sections: [...timeline.sections, newSection] });
    setSelectedSectionId(id);
  };

  const deleteSection = (id: string) => {
    onTimelineChange({ ...timeline, sections: timeline.sections.filter((s) => s.id !== id) });
    if (selectedSectionId === id) setSelectedSectionId(null);
  };

  const addSectionAtBar = (bar: number, len = 8) => {
    // Find first free slot at or after `bar`
    const sorted = [...timeline.sections].sort((a, b) => a.startBar - b.startBar);
    let start = Math.max(1, Math.round(bar));
    let end = Math.min(timeline.totalBars, start + len);
    for (const s of sorted) {
      if (start < s.endBar && end > s.startBar) {
        start = s.endBar;
        end = Math.min(timeline.totalBars, start + len);
      }
    }
    if (start >= timeline.totalBars) return;
    const typeId = timeline.sectionTypes[0]?.id ?? "";
    const id = `sec_${Date.now()}`;
    const newSec: SectionInstance = { id, typeId, label: "New", startBar: start, endBar: end };
    onTimelineChange({ ...timeline, sections: [...timeline.sections, newSec] });
    setSelectedSectionId(id);
  };

  const pasteSection = () => {
    if (!copiedSection) return;
    const len = copiedSection.endBar - copiedSection.startBar;
    const sorted = [...timeline.sections].sort((a, b) => a.startBar - b.startBar);
    let start = Math.max(1, Math.round(currentBar));
    let end = Math.min(timeline.totalBars, start + len);
    for (const s of sorted) {
      if (start < s.endBar && end > s.startBar) { start = s.endBar; end = Math.min(timeline.totalBars, start + len); }
    }
    if (start >= timeline.totalBars) return;
    const id = `sec_${Date.now()}`;
    const newSec: SectionInstance = { id, typeId: copiedSection.typeId, label: copiedSection.label, startBar: start, endBar: end };
    onTimelineChange({ ...timeline, sections: [...timeline.sections, newSec] });
    setSelectedSectionId(id);
  };

  const exportSections = () => {
    const data = {
      version: 1,
      totalBars: timeline.totalBars,
      sectionTypes: timeline.sectionTypes,
      sections: timeline.sections,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sections-${timeline.id ?? "export"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importRef = useRef<HTMLInputElement | null>(null);

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const json = JSON.parse(ev.target?.result as string);
        if (!Array.isArray(json.sections) || !Array.isArray(json.sectionTypes)) {
          alert("格式錯誤：缺少 sections 或 sectionTypes");
          return;
        }
        const next = {
          ...timeline,
          sectionTypes: json.sectionTypes,
          sections: json.sections,
          ...(typeof json.totalBars === "number" ? { totalBars: json.totalBars } : {}),
        };
        onTimelineChange(next);
        setSelectedSectionId(null);
      } catch {
        alert("JSON 解析失敗，請確認檔案格式");
      }
    };
    reader.readAsText(file);
  };

  const onPointerMoveSvg = (event: PointerEvent<SVGSVGElement>) => {
    if (playheadDragRef.current) {
      scrubToPointer(event);
      return;
    }

    // Pinch-to-zoom: only zoom X, anchored at the current playhead bar
    if (
      pinchRef.current &&
      pinchRef.current.id1 !== -1 &&
      (event.pointerId === pinchRef.current.id0 || event.pointerId === pinchRef.current.id1)
    ) {
      // We can't get both touch positions from a single PointerEvent, so we track via cache
      // Update the cached position for this pointer
      const p = pinchRef.current;
      const svg = svgRef.current!;
      const touches = (svg as unknown as { _touches?: Record<number, { x: number; y: number }> })._touches ?? {};
      touches[event.pointerId] = { x: event.clientX, y: event.clientY };
      (svg as unknown as { _touches: Record<number, { x: number; y: number }> })._touches = touches;
      if (touches[p.id0] && touches[p.id1] && wrapperRef.current) {
        const dx = touches[p.id0].x - touches[p.id1].x;
        const dy = touches[p.id0].y - touches[p.id1].y;
        const newDist = Math.sqrt(dx * dx + dy * dy);
        const ratio = p.dist > 0 ? newDist / p.dist : 1;
        const nextWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, p.startWidth * ratio));
        const oldPlayX = ((p.playBar - 1) / (timeline.totalBars - 1)) * p.startWidth;
        const newPlayX = ((p.playBar - 1) / (timeline.totalBars - 1)) * nextWidth;
        const playheadScreenX = oldPlayX - p.startScrollLeft;
        const maxScroll = Math.max(0, nextWidth - wrapperRef.current.clientWidth);
        const nextScrollLeft = Math.max(0, Math.min(maxScroll, newPlayX - playheadScreenX));
        setWidth(nextWidth);
        requestAnimationFrame(() => {
          if (wrapperRef.current) wrapperRef.current.scrollLeft = nextScrollLeft;
        });
      }
      return;
    }

    if (bgPanRef.current && wrapperRef.current) {
      const rect = svgRef.current!.getBoundingClientRect();
      const curX = event.clientX - rect.left;
      const dx = bgPanRef.current.startX - curX;
      wrapperRef.current.scrollLeft = bgPanRef.current.startScrollLeft + dx;
      return;
    }

    const activeDragId = dragIdRef.current ?? dragId;
    if (activeDragId) {
      const { x, y } = pointerToLocal(event);
      updateAnchor(activeDragId, { bar: xToBar(x), bpm: yToBpm(y) });
      return;
    }
    if (!sectionDrag) return;
    const rect = svgRef.current!.getBoundingClientRect();
    const curX = Math.max(0, Math.min(WIDTH, event.clientX - rect.left));
    const dX = curX - sectionDrag.ptrX;
    const dBar = xToBarCont(dX + (sectionDrag.ptrX)) - xToBarCont(sectionDrag.ptrX);

    if (sectionDrag.kind === "move") {
      const len = sectionDrag.origEnd - sectionDrag.origStart;
      const rawStart = sectionDrag.origStart + dBar;
      const rawEnd = rawStart + len;
      const s = Math.max(1, Math.round(rawStart));
      const e = Math.min(timeline.totalBars, s + len);
      const clamped = clampSection(sectionDrag.id, s, Math.round(e));
      commitSection(sectionDrag.id, clamped);
    } else if (sectionDrag.kind === "resize-l") {
      const rawStart = sectionDrag.origStart + dBar;
      const section = timeline.sections.find((s) => s.id === sectionDrag.id)!;
      const clamped = clampSection(sectionDrag.id, rawStart, section.endBar);
      commitSection(sectionDrag.id, { startBar: clamped.startBar });
    } else if (sectionDrag.kind === "resize-r") {
      const rawEnd = sectionDrag.origEnd + dBar;
      const section = timeline.sections.find((s) => s.id === sectionDrag.id)!;
      const clamped = clampSection(sectionDrag.id, section.startBar, rawEnd);
      commitSection(sectionDrag.id, { endBar: clamped.endBar });
    }
  };

  const onPointerUpSvg = (event: PointerEvent<SVGElement>) => {
    bgPanRef.current = null;
    const svg = svgRef.current;
    if (svg) {
      const touches = (svg as unknown as { _touches?: Record<number, { x: number; y: number }> })._touches;
      if (touches) delete touches[event.pointerId];
    }
    if (pinchRef.current && (event.pointerId === pinchRef.current.id0 || event.pointerId === pinchRef.current.id1)) {
      pinchRef.current = null;
    }
    if (scrubRafRef.current !== null) {
      cancelAnimationFrame(scrubRafRef.current);
      scrubRafRef.current = null;
    }
    if (onCurrentBarChange && scrubBarRef.current !== null) {
      onCurrentBarChange(scrubBarRef.current);
    }
    scrubBarRef.current = null;
    playheadDragRef.current = false;
    setPlayheadDragging(false);
    if (!isPlaying) setPlayheadHover(false);
    dragIdRef.current = null;
    setDragId(null);
    setSectionDrag(null);
  };

  const zoomXAtPlayhead = (ratio: number) => {
    if (!wrapperRef.current) return;
    const nextWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width * ratio));
    if (Math.abs(nextWidth - width) < 0.5) return;
    const playBar = Math.max(1, Math.min(timeline.totalBars, currentBar));
    const oldPlayX = ((playBar - 1) / (timeline.totalBars - 1)) * width;
    const newPlayX = ((playBar - 1) / (timeline.totalBars - 1)) * nextWidth;
    const playheadScreenX = oldPlayX - wrapperRef.current.scrollLeft;
    const maxScroll = Math.max(0, nextWidth - wrapperRef.current.clientWidth);
    const nextScrollLeft = Math.max(0, Math.min(maxScroll, newPlayX - playheadScreenX));
    setWidth(nextWidth);
    requestAnimationFrame(() => {
      if (wrapperRef.current) wrapperRef.current.scrollLeft = nextScrollLeft;
    });
  };

  const onWheelTimeline = (event: globalThis.WheelEvent) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;

    const inTempoArea = event.clientY - rect.top >= SECTION_H;
    if (event.altKey && inTempoArea) {
      event.preventDefault();
      const currentIndex = Y_SPAN_OPTIONS.indexOf(ySpan);
      if (currentIndex < 0) return;
      if (event.deltaY < 0 && currentIndex > 0) {
        setYSpan(Y_SPAN_OPTIONS[currentIndex - 1]);
      } else if (event.deltaY > 0 && currentIndex < Y_SPAN_OPTIONS.length - 1) {
        setYSpan(Y_SPAN_OPTIONS[currentIndex + 1]);
      }
      return;
    }

    event.preventDefault();
    const primaryDelta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (!Number.isFinite(primaryDelta) || Math.abs(primaryDelta) < 0.01) return;
    const sensitivity = event.ctrlKey ? 0.0022 : 0.0014;
    const ratio = Math.exp(-primaryDelta * sensitivity);
    zoomXAtPlayhead(ratio);
  };

  // Must be non-passive so preventDefault() works for wheel zoom
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheelTimeline, { passive: false });
    return () => el.removeEventListener("wheel", onWheelTimeline);
  });

  const onSvgDoubleClick = (event: PointerEvent<SVGSVGElement>) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const localY = event.clientY - rect.top;
    const localX = Math.max(0, Math.min(WIDTH, event.clientX - rect.left));
    if (localY < SECTION_H) {
      if (editMode) addSection(localX);
      return;
    }
    addAnchor(event);
  };

  const currentSection = getSectionAtBar(timeline, currentBar);
  const currentBpm = getTimelineBpmAtBar(timeline, currentBar);
  const sortedAnchors = [...timeline.tempoAnchors].sort((a, b) => a.bar - b.bar);
  const points = sortedAnchors.map((a) => `${barToX(a.bar)},${SECTION_H + bpmToY(a.bpm)}`).join(" ");

  const selectedSection = timeline.sections.find((s) => s.id === selectedSectionId) ?? null;

  return (
    <div className="card grid">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h2 style={{ margin: 0 }}>Timeline Editor</h2>
          <p className="small">點擊 Tempo 區可新增錨點；拖曳錨點可改 bar / BPM。雙擊錨點可刪除。滾輪可做 X 軸縮放（觸控板/滑鼠）；`Alt + 滾輪` 調整 Y 軸範圍。</p>
        </div>
        <div className="row">
          <button
            className={`btn${editMode ? " primary" : ""}`}
            onClick={() => { setEditMode((v) => !v); if (editMode) { setSelectedSectionId(null); setSectionDrag(null); } }}
          >
            {editMode ? "✎ 編輯中" : "編輯段落"}
          </button>
          {editMode && (
            <>
              <button className="btn" onClick={() => addSectionAtBar(Math.round(currentBar))}>＋ 新增</button>
              {copiedSection && (
                <button className="btn" onClick={pasteSection}>⎘ 貼上</button>
              )}
            </>
          )}
          <button className="btn" onClick={exportSections}>↓ 匯出</button>
          <button className="btn" onClick={() => importRef.current?.click()}>↑ 匯入</button>
          <input ref={importRef} type="file" accept=".json,application/json" style={{ display: "none" }} onChange={handleImportFile} />
          <label className="row">
            <span className="label">總 Bars</span>
            <input
              className="input"
              type="number"
              min={4}
              style={{ width: 72 }}
              value={timeline.totalBars}
              onChange={(e) => {
                const bars = Math.max(4, Number(e.target.value) || 4);
                onTimelineChange({ ...timeline, totalBars: bars });
              }}
            />
          </label>
          <label className="row">
            <span className="label">Y 軸範圍</span>
            <select className="input" value={ySpan} onChange={(event) => setYSpan(Number(event.target.value))}>
              {Y_SPAN_OPTIONS.map((span) => (
                <option key={span} value={span}>±{span} BPM</option>
              ))}
            </select>
          </label>
          <div className="small">目前：{currentSection?.label ?? "--"}｜Bar {currentBar.toFixed(2)}｜{currentBpm.toFixed(1)} BPM</div>
        </div>
      </div>

      <div ref={wrapperRef} className="timeline-scroll" style={{ overflowX: "auto" }}>
        <svg
          ref={svgRef}
          className="timeline"
          width={WIDTH}
          height={SECTION_H + TEMPO_H + 34}
          onDoubleClick={onSvgDoubleClick as unknown as React.MouseEventHandler<SVGSVGElement>}
          onPointerMove={onPointerMoveSvg}
          onPointerUp={onPointerUpSvg}
          onPointerCancel={onPointerUpSvg}
        >
          <rect
            x={0} y={0} width={WIDTH} height={SECTION_H + TEMPO_H} fill="#111520" rx={16}
            onPointerDown={(e) => {
              // Two-finger pinch-to-zoom (X only)
              if (pinchRef.current) {
                const p = pinchRef.current;
                if (p.id0 !== e.pointerId && p.id1 === -1 && e.pointerType === "touch") {
                  p.id1 = e.pointerId;
                  bgPanRef.current = null;
                  const svg = svgRef.current!;
                  const touches = (svg as unknown as { _touches?: Record<number, { x: number; y: number }> })._touches ?? {};
                  touches[e.pointerId] = { x: e.clientX, y: e.clientY };
                  if (touches[p.id0] && touches[p.id1]) {
                    const dx = touches[p.id0].x - touches[p.id1].x;
                    const dy = touches[p.id0].y - touches[p.id1].y;
                    p.dist = Math.sqrt(dx * dx + dy * dy);
                  }
                  return;
                }
                // Defensive reset: stale pinch state should not block new gestures
                if (p.id1 !== -1 && p.id0 !== e.pointerId && p.id1 !== e.pointerId) {
                  pinchRef.current = null;
                } else {
                  return;
                }
              }
              // Single finger on background → X pan
              if (!dragId && !sectionDrag) {
                svgRef.current!.setPointerCapture(e.pointerId);
                const rect2 = svgRef.current!.getBoundingClientRect();
                bgPanRef.current = {
                  startX: e.clientX - rect2.left,
                  startScrollLeft: wrapperRef.current?.scrollLeft ?? 0,
                };
                if (e.pointerType === "touch") {
                  // Start tracking for potential pinch only on touch devices
                  const svg = svgRef.current!;
                  const touches = (svg as unknown as { _touches?: Record<number, { x: number; y: number }> })._touches ?? {};
                  touches[e.pointerId] = { x: e.clientX, y: e.clientY };
                  (svg as unknown as { _touches: Record<number, { x: number; y: number }> })._touches = touches;
                  pinchRef.current = {
                    id0: e.pointerId,
                    id1: -1,
                    dist: 0,
                    startWidth: WIDTH,
                    startScrollLeft: wrapperRef.current?.scrollLeft ?? 0,
                    playBar: Math.max(1, Math.min(timeline.totalBars, currentBar)),
                  };
                }
              }
            }}
          />

          {/* Section lane */}
          {editMode && (
            <rect x={0} y={0} width={WIDTH} height={SECTION_H} fill="transparent"
              style={{ cursor: "crosshair" }} />
          )}

          {timeline.sections.map((section) => {
            const type = sectionTypeMap.get(section.typeId);
            const x = barToX(section.startBar);
            const w = Math.max(HANDLE_W * 2 + 4, barToX(section.endBar) - x);
            const isSelected = selectedSectionId === section.id;
            const isActive = activeSectionId === section.id;

            return (
              <g key={section.id}>
                <rect
                  x={x + 2} y={10} width={w - 4} height={46} rx={12}
                  fill={type?.color ?? "#475569"}
                  opacity={isSelected ? 1 : 0.86}
                  stroke={isActive ? "#facc15" : isSelected ? "#fff" : "none"}
                  strokeWidth={isActive || isSelected ? 2.5 : 0}
                  style={{ cursor: editMode ? "grab" : onSectionClick ? "pointer" : "default" }}
                  onPointerDown={editMode ? (e) => {
                    e.stopPropagation();
                    svgRef.current!.setPointerCapture(e.pointerId);
                    setSelectedSectionId(section.id);
                    const rect2 = svgRef.current!.getBoundingClientRect();
                    setSectionDrag({
                      kind: "move",
                      id: section.id,
                      origStart: section.startBar,
                      origEnd: section.endBar,
                      ptrX: Math.max(0, Math.min(WIDTH, e.clientX - rect2.left))
                    });
                  } : undefined}
                  onClick={editMode
                    ? (e) => { e.stopPropagation(); setSelectedSectionId(section.id); }
                    : (e) => { e.stopPropagation(); onSectionClick?.(section.id); }
                  }
                />
                <text x={x + w / 2} y={38} textAnchor="middle" fill="white" fontSize="13" fontWeight="700" pointerEvents="none">{section.label}</text>

                {/* Resize handles (edit mode only) */}
                {editMode && (
                  <>
                    <rect
                      x={x + 2} y={10} width={HANDLE_W} height={46} rx={4}
                      fill="rgba(255,255,255,0.25)"
                      style={{ cursor: "ew-resize" }}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        svgRef.current!.setPointerCapture(e.pointerId);
                        setSelectedSectionId(section.id);
                        const rect2 = svgRef.current!.getBoundingClientRect();
                        setSectionDrag({
                          kind: "resize-l",
                          id: section.id,
                          origStart: section.startBar,
                          ptrX: Math.max(0, Math.min(WIDTH, e.clientX - rect2.left))
                        });
                      }}
                    />
                    <rect
                      x={x + w - HANDLE_W - 2} y={10} width={HANDLE_W} height={46} rx={4}
                      fill="rgba(255,255,255,0.25)"
                      style={{ cursor: "ew-resize" }}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        svgRef.current!.setPointerCapture(e.pointerId);
                        setSelectedSectionId(section.id);
                        const rect2 = svgRef.current!.getBoundingClientRect();
                        setSectionDrag({
                          kind: "resize-r",
                          id: section.id,
                          origEnd: section.endBar,
                          ptrX: Math.max(0, Math.min(WIDTH, e.clientX - rect2.left))
                        });
                      }}
                    />
                  </>
                )}
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

          {yTicks.map((bpm) => {
            const y = SECTION_H + bpmToY(bpm);
            return (
              <g key={bpm}>
                <line x1={0} y1={y} x2={WIDTH} y2={y} stroke="#252b3a" />
                <text x={6} y={y - 4} fill="#8f96aa" fontSize="11">{bpm}</text>
              </g>
            );
          })}

          <polyline points={points} fill="none" stroke="#f8c471" strokeWidth={3} opacity={dimTempo ? 0.2 : 1} />

          <g opacity={dimTempo ? 0.2 : 1}>
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
                    onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); dragIdRef.current = anchor.id; setDragId(anchor.id); }}
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
          </g>

          {(playheadHover || playheadDragging) && (
            <line
              x1={playheadX}
              y1={0}
              x2={playheadX}
              y2={SECTION_H + TEMPO_H}
              stroke="#8ab4f8"
              strokeWidth={6}
              opacity={0.5}
              pointerEvents="none"
            />
          )}
          <line x1={playheadX} y1={0} x2={playheadX} y2={SECTION_H + TEMPO_H} stroke="white" strokeWidth={2} opacity={0.9} pointerEvents="none" />
          <rect
            data-testid="playhead-handle"
            x={playheadX - 10}
            y={0}
            width={20}
            height={SECTION_H + TEMPO_H}
            fill="rgba(255,255,255,0.001)"
            pointerEvents="all"
            style={{ cursor: onCurrentBarChange ? "ew-resize" : "default" }}
            onPointerEnter={() => { if (!isPlaying) setPlayheadHover(true); }}
            onPointerLeave={() => { if (!playheadDragRef.current) setPlayheadHover(false); }}
            onPointerMove={onCurrentBarChange ? (e) => {
              if (!playheadDragRef.current) return;
              scrubToPointer(e);
            } : undefined}
            onPointerUp={onCurrentBarChange ? (e) => {
              onPointerUpSvg(e);
            } : undefined}
            onPointerDown={onCurrentBarChange ? (e) => {
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              playheadDragRef.current = true;
              setPlayheadDragging(true);
              setPlayheadHover(true);
              scrubToPointer(e);
            } : undefined}
          />
        </svg>
      </div>

      {/* Section editor panel — only visible in edit mode when a section is selected */}
      {editMode && selectedSection && (
        <div style={{ background: "#1a2035", borderRadius: 12, padding: "14px 16px", display: "grid", gap: 12 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="label" style={{ fontSize: 14, color: "#f4f4f5" }}>編輯段落：<strong>{selectedSection.label}</strong></span>
            <div className="row" style={{ gap: 8 }}>
              <button
                className="btn"
                style={{ padding: "4px 10px", fontSize: 13 }}
                onClick={() => setCopiedSection(selectedSection)}
              >
                ⎘ 複製
              </button>
              <button className="btn danger" style={{ padding: "4px 10px", fontSize: 13 }} onClick={() => deleteSection(selectedSection.id)}>刪除</button>
            </div>
          </div>
          <div className="row">
            <label className="row">
              <span className="label">名稱</span>
              <input
                className="input"
                type="text"
                value={selectedSection.label}
                style={{ width: 120 }}
                onChange={(e) => commitSection(selectedSection.id, { label: e.target.value })}
              />
            </label>
            <label className="row">
              <span className="label">類型</span>
              <select
                className="input"
                value={selectedSection.typeId}
                onChange={(e) => commitSection(selectedSection.id, { typeId: e.target.value })}
              >
                {timeline.sectionTypes.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </label>
            <div className="small">Bar {selectedSection.startBar} – {selectedSection.endBar}</div>
          </div>
        </div>
      )}
    </div>
  );
}
