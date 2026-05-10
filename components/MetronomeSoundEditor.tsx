"use client";

import { useEffect, useRef, useState } from "react";
import { MetronomeSound, WaveType } from "@/lib/metronome/metronomeSound";

interface Props {
  initial: MetronomeSound | null; // null = new
  onSave: (sound: MetronomeSound) => void;
  onCancel: () => void;
  /** preview a click using an external AudioContext */
  onPreview: (sound: MetronomeSound) => void;
}

const WAVES: { value: WaveType; label: string }[] = [
  { value: "sine", label: "正弦波 sine" },
  { value: "square", label: "方波 square" },
  { value: "triangle", label: "三角波 triangle" },
  { value: "sawtooth", label: "鋸齒波 sawtooth" },
];

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function numInput(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  onChange: (v: number) => void,
  unit = "",
) {
  return (
    <label className="row" style={{ gap: 8, flexWrap: "wrap" }}>
      <span className="label" style={{ minWidth: 110 }}>{label}</span>
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        onChange={(e) => onChange(clamp(Number(e.target.value), min, max))}
        style={{ width: 120 }}
      />
      <input
        type="number"
        min={min} max={max} step={step}
        value={value}
        onChange={(e) => onChange(clamp(Number(e.target.value), min, max))}
        style={{ width: 72 }}
      />
      {unit && <span className="small">{unit}</span>}
    </label>
  );
}

export function MetronomeSoundEditor({ initial, onSave, onCancel, onPreview }: Props) {
  const defaultNew: MetronomeSound = {
    id: `custom-${Date.now()}`,
    name: "自訂音色",
    wave: "triangle",
    accentFreq: 1800, beatFreq: 1200,
    accentPeak: 0.9, beatPeak: 0.55,
    attack: 0.002, decay: 0.04, duration: 0.05,
  };

  const [sound, setSound] = useState<MetronomeSound>(
    initial ? { ...initial, builtIn: undefined } : defaultNew,
  );

  // Give a fresh id if editing a built-in (save-as-new behaviour is NOT triggered here,
  // but we block saving over built-ins at the panel level anyway)
  const idRef = useRef(initial?.id ?? defaultNew.id);

  const set = <K extends keyof MetronomeSound>(key: K, value: MetronomeSound[K]) =>
    setSound((prev) => ({ ...prev, [key]: value }));

  // reset id to something stable when creating new
  useEffect(() => {
    if (!initial) {
      setSound((prev) => ({ ...prev, id: `custom-${Date.now()}` }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSave = () => {
    const trimmed = sound.name.trim();
    if (!trimmed) return;
    onSave({ ...sound, id: idRef.current, name: trimmed });
  };

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(0,0,0,0.6)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        className="card grid"
        style={{ width: "min(520px, 95vw)", maxHeight: "90vh", overflowY: "auto", gap: 14 }}
      >
        <h3 style={{ margin: 0 }}>{initial ? "編輯音色" : "新增音色"}</h3>

        {/* Name */}
        <label className="row" style={{ gap: 8 }}>
          <span className="label" style={{ minWidth: 110 }}>名稱</span>
          <input
            type="text"
            value={sound.name}
            onChange={(e) => set("name", e.target.value)}
            style={{ flex: 1 }}
          />
        </label>

        {/* Wave type */}
        <label className="row" style={{ gap: 8 }}>
          <span className="label" style={{ minWidth: 110 }}>波形</span>
          <select
            value={sound.wave}
            onChange={(e) => set("wave", e.target.value as WaveType)}
          >
            {WAVES.map((w) => (
              <option key={w.value} value={w.value}>{w.label}</option>
            ))}
          </select>
        </label>

        <hr style={{ margin: "4px 0", opacity: 0.2 }} />
        <p className="small" style={{ margin: 0, opacity: 0.6 }}>頻率</p>
        {numInput("重音頻率", sound.accentFreq, 200, 4000, 10, (v) => set("accentFreq", v), "Hz")}
        {numInput("一般拍頻率", sound.beatFreq, 200, 4000, 10, (v) => set("beatFreq", v), "Hz")}

        <hr style={{ margin: "4px 0", opacity: 0.2 }} />
        <p className="small" style={{ margin: 0, opacity: 0.6 }}>音量峰值</p>
        {numInput("重音峰值", sound.accentPeak, 0.1, 1, 0.01, (v) => set("accentPeak", v))}
        {numInput("一般拍峰值", sound.beatPeak, 0.1, 1, 0.01, (v) => set("beatPeak", v))}

        <hr style={{ margin: "4px 0", opacity: 0.2 }} />
        <p className="small" style={{ margin: 0, opacity: 0.6 }}>包絡</p>
        {numInput("Attack", sound.attack, 0.0005, 0.05, 0.0005, (v) => set("attack", v), "s")}
        {numInput("Decay", sound.decay, 0.005, 0.3, 0.005, (v) => set("decay", v), "s")}
        {numInput("Duration", sound.duration, 0.01, 0.5, 0.005, (v) => set("duration", v), "s")}

        <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <button className="btn" onClick={() => onPreview(sound)}>▶ 試聽</button>
          <button className="btn" onClick={onCancel}>取消</button>
          <button className="btn primary" onClick={handleSave}>儲存</button>
        </div>
      </div>
    </div>
  );
}
