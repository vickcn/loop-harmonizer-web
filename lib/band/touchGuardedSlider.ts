export const TOUCH_SLIDER_LONG_PRESS_MS = 350;
export const TOUCH_SLIDER_MOVE_CANCEL_PX = 10;

export function clampAndStepSliderValue(
  rawValue: number,
  min: number,
  max: number,
  step: number,
): number {
  const safeMin = Number.isFinite(min) ? min : 0;
  const safeMax = Number.isFinite(max) && max >= safeMin ? max : safeMin;
  if (!Number.isFinite(rawValue)) {
    return clampAndStepSliderValue(safeMin, safeMin, safeMax, step);
  }
  const clamped = Math.max(safeMin, Math.min(safeMax, rawValue));
  if (!(step > 0 && Number.isFinite(step))) {
    return clamped;
  }
  const snapped = safeMin + Math.round((clamped - safeMin) / step) * step;
  const reclamped = Math.max(safeMin, Math.min(safeMax, snapped));
  return Number(reclamped.toFixed(6));
}

export function computeAbsoluteSliderValue(
  clientX: number,
  rectLeft: number,
  rectWidth: number,
  min: number,
  max: number,
  step: number,
): number {
  if (!(rectWidth > 0 && Number.isFinite(rectWidth))) {
    return clampAndStepSliderValue(min, min, max, step);
  }
  const ratio = Math.max(0, Math.min(1, (clientX - rectLeft) / rectWidth));
  return clampAndStepSliderValue(min + ratio * (max - min), min, max, step);
}

export function computeRelativeSliderValue(
  startValue: number,
  deltaX: number,
  rectWidth: number,
  min: number,
  max: number,
  step: number,
): number {
  if (!(rectWidth > 0 && Number.isFinite(rectWidth))) {
    return clampAndStepSliderValue(startValue, min, max, step);
  }
  const raw = startValue + (deltaX / rectWidth) * (max - min);
  return clampAndStepSliderValue(raw, min, max, step);
}

export function shouldCancelSliderLongPress(
  dx: number,
  dy: number,
  maxMovePx: number = TOUCH_SLIDER_MOVE_CANCEL_PX,
): boolean {
  return Math.hypot(dx, dy) > maxMovePx;
}

export function computeKeyboardSliderValue(
  currentValue: number,
  key: string,
  shiftKey: boolean,
  min: number,
  max: number,
  step: number,
): number | null {
  const baseStep =
    step > 0 && Number.isFinite(step) ? step : Math.abs(max - min) / 100 || 0.01;
  const delta = shiftKey ? baseStep * 10 : baseStep;

  switch (key) {
    case "ArrowLeft":
    case "ArrowDown":
      return clampAndStepSliderValue(currentValue - delta, min, max, step);
    case "ArrowRight":
    case "ArrowUp":
      return clampAndStepSliderValue(currentValue + delta, min, max, step);
    case "PageDown":
      return clampAndStepSliderValue(currentValue - baseStep * 10, min, max, step);
    case "PageUp":
      return clampAndStepSliderValue(currentValue + baseStep * 10, min, max, step);
    case "Home":
      return clampAndStepSliderValue(min, min, max, step);
    case "End":
      return clampAndStepSliderValue(max, min, max, step);
    default:
      return null;
  }
}
