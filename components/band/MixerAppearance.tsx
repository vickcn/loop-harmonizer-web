"use client";

import { useLayoutEffect, useState } from "react";
import { readMixerTheme, saveMixerTheme, type MixerTheme } from "@/lib/band/mixerAppearance";

type Theme = MixerTheme;

/** Device preference only: deliberately independent of song/project stores. */
export function MixerAppearance() {
  const [theme, setTheme] = useState<Theme>("graphite");
  useLayoutEffect(() => {
    let saved: Theme = "graphite";
    try { saved = readMixerTheme(localStorage); } catch {}
    document.documentElement.dataset.mixerTheme = saved;
    setTheme(saved);
    return () => { delete document.documentElement.dataset.mixerTheme; };
  }, []);
  const select = (next: Theme) => {
    document.documentElement.dataset.mixerTheme = next;
    setTheme(next);
    try { saveMixerTheme(localStorage, next); } catch {}
  };
  return <fieldset className="mixer-appearance col-full">
    <legend>外觀設定</legend>
    {(["graphite", "daylight"] as const).map(value => <button key={value} type="button" aria-pressed={theme === value} onClick={() => select(value)}>
      <span className={`theme-preview ${value}`} aria-hidden="true" />
      {value === "graphite" ? "Graphite Pro" : "Daylight Studio"}
      {theme === value && <span aria-hidden="true"> ✓</span>}
    </button>)}
  </fieldset>;
}
