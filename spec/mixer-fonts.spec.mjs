import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(path, "utf8");

test("Band Mixer loads Latin variable fonts and exposes semantic font tokens", () => {
  const fonts = read("app/band-mixer/fonts.ts");
  const css = read("app/mixer-themes.css");
  assert.match(fonts, /Space_Grotesk/);
  assert.match(fonts, /Manrope/);
  assert.equal((fonts.match(/subsets: \["latin"\]/g) ?? []).length, 2);
  assert.equal((fonts.match(/display: "swap"/g) ?? []).length, 2);
  for (const token of ["--font-brand", "--font-heading", "--font-interface", "--font-numeric"]) {
    assert.match(css, new RegExp(token));
  }
  assert.match(css, /"PingFang TC", "Microsoft JhengHei", "Noto Sans TC", sans-serif/);
  assert.match(css, /font-variant-numeric: tabular-nums/);
});

test("font scope reaches mixer portals without replacing the theme manager", () => {
  const page = read("app/band-mixer/page.tsx");
  const appearance = read("components/band/MixerAppearance.tsx");
  assert.match(page, /mixerFontVariableClasses/);
  assert.match(page, /band-mixer-page/);
  assert.match(appearance, /document\.documentElement\.classList\.add/);
  assert.match(appearance, /document\.documentElement\.classList\.remove/);
  assert.match(appearance, /document\.documentElement\.dataset\.mixerTheme/);
});
