import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const read = (file) => fs.readFileSync(path.resolve(file), "utf8");

test("Google account UI derives toolbar token state from a pure Snapshot read", () => {
  const mixer = read("components/band/BandMixer.tsx");
  const picker = read("components/band/GoogleDrivePickerButton.tsx");
  const toolbar = read("components/band/ProjectToolbar.tsx");
  const dialog = read("components/band/ProjectManagerDialog.tsx");

  const toolbarProps = mixer.slice(mixer.lastIndexOf("<ProjectToolbar"), mixer.indexOf("<div className=\"card row mixer-upload\""));
  assert.match(toolbarProps, /hasValidGoogleToken=\{isGoogleTokenSnapshotUsable\(googleAuth\)\}/);
  assert.doesNotMatch(toolbarProps, /getValidAccessToken\(/);

  // Picker 的 Token 取得限於點擊操作；Toolbar/Dialog 本身不直接接觸可變帳戶管理器。
  const pickerRenderPrefix = picker.slice(0, picker.indexOf("const handleClick"));
  assert.doesNotMatch(pickerRenderPrefix, /getValidAccessToken\(/);
  assert.doesNotMatch(toolbar, /getValidAccessToken\(|markTokenExpired\(/);
  assert.doesNotMatch(dialog, /getValidAccessToken\(|markTokenExpired\(/);
});
