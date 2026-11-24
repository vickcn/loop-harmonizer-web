"use client";

import { useLayoutEffect, useState } from "react";
import { readMixerTheme, saveMixerTheme, type MixerTheme } from "@/lib/band/mixerAppearance";

type Theme = MixerTheme;

/** Device preference only: deliberately independent of song/project stores. */
export function MixerAppearance({ fontVariableClasses = "" }: { fontVariableClasses?: string }) {
  const [theme, setTheme] = useState<Theme>("graphite");
  useLayoutEffect(() => {
    const fontClasses = fontVariableClasses.split(/\s+/).filter(Boolean);
    document.documentElement.classList.add(...fontClasses);
    let saved: Theme = "graphite";
    try { saved = readMixerTheme(localStorage); } catch {}
    document.documentElement.dataset.mixerTheme = saved;
    setTheme(saved);
    return () => {
      delete document.documentElement.dataset.mixerTheme;
      document.documentElement.classList.remove(...fontClasses);
    };
  }, [fontVariableClasses]);
  const select = (next: Theme) => {
    document.documentElement.dataset.mixerTheme = next;
    setTheme(next);
    try { saveMixerTheme(localStorage, next); } catch {}
  };
  return (
    <fieldset className="mixer-appearance" aria-label="外觀主題">
      <legend className="mixer-visually-hidden">外觀主題</legend>
      <button
        type="button"
        aria-label="使用 Graphite Pro 深色主題"
        aria-pressed={theme === "graphite"}
        title="Graphite Pro"
        onClick={() => select("graphite")}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="M20.4 15.2A8.5 8.5 0 0 1 8.8 3.6 9 9 0 1 0 20.4 15.2Z" fill="currentColor" />
        </svg>
      </button>
      <button
        type="button"
        aria-label="使用 Daylight Studio 淺色主題"
        aria-pressed={theme === "daylight"}
        title="Daylight Studio"
        onClick={() => select("daylight")}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <circle cx="12" cy="12" r="4" fill="currentColor" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>
    </fieldset>
  );
}
