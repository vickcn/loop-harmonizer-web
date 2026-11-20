import test from "node:test";
import assert from "node:assert/strict";
import {
  clearCachedGoogleAccessToken,
  downloadGoogleDriveFile,
  ensureGooglePickerSdkLoaded,
  extractGoogleAppId,
  getGoogleDriveConfig,
  getGoogleDriveConfigStatus,
  getGoogleSdkReadiness,
  isGoogleDrivePickerConfigured,
  openGoogleDrivePicker,
  resetGoogleSdkLoaderForTests,
} from "../lib/google/googleDrivePicker.ts";
import { DriveApiError, resolveDriveFileForDownload } from "../lib/google/driveClient.ts";

function installFakeDomForSdk({
  scriptBehavior = "load",
  gapiBehavior = "load",
} = {}) {
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const scripts = [];

  class FakeScript {
    constructor() {
      this.dataset = {};
      this.listeners = new Map();
      this._src = "";
      this.async = false;
      this.defer = false;
      this.removed = false;
    }
    set src(value) {
      this._src = value;
      const mode =
        typeof scriptBehavior === "function" ? scriptBehavior(value, scripts.length) : scriptBehavior;
      queueMicrotask(() => {
        if (mode === "load") {
          if (value.includes("accounts.google.com/gsi/client")) {
            globalThis.window.google = globalThis.window.google || {};
            globalThis.window.google.accounts = {
              oauth2: {
                initTokenClient: () => ({ requestAccessToken: () => {} }),
                revoke: (_t, cb) => cb?.(),
              },
            };
          }
          if (value.includes("apis.google.com/js/api.js")) {
            globalThis.window.gapi = {
              load: (_name, opts) => {
                const gMode =
                  typeof gapiBehavior === "function" ? gapiBehavior(scripts.length) : gapiBehavior;
                if (gMode === "load") {
                  globalThis.window.google = globalThis.window.google || {};
                  globalThis.window.google.picker = {
                    ViewId: { DOCS: "DOCS" },
                    Action: { PICKED: "picked", CANCEL: "cancel" },
                    Feature: { MULTISELECT_ENABLED: "multiselect", SUPPORT_DRIVES: "support_drives" },
                    DocsView: class {},
                    PickerBuilder: class {},
                  };
                  opts.callback?.();
                } else if (gMode === "error") {
                  opts.onerror?.();
                } else if (gMode === "timeout") {
                  opts.ontimeout?.();
                }
              },
            };
          }
          this.listeners.get("load")?.forEach((cb) => cb());
        } else if (mode === "error") {
          this.listeners.get("error")?.forEach((cb) => cb());
        }
        // mode === "hang" intentionally emits nothing so timeout fires
      });
    }
    get src() {
      return this._src;
    }
    addEventListener(name, cb) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name).add(cb);
    }
    removeEventListener(name, cb) {
      this.listeners.get(name)?.delete(cb);
    }
    remove() {
      this.removed = true;
      const idx = scripts.indexOf(this);
      if (idx >= 0) scripts.splice(idx, 1);
    }
  }

  globalThis.window = {
    location: { origin: "http://localhost:3000" },
  };
  globalThis.document = {
    head: {
      appendChild(node) {
        scripts.push(node);
      },
    },
    querySelector(selector) {
      const m = /script\[src="([^"]+)"\]/.exec(selector);
      if (!m) return null;
      return scripts.find((s) => s._src === m[1]) ?? null;
    },
    createElement(tag) {
      assert.equal(tag, "script");
      return new FakeScript();
    },
  };

  return {
    scripts,
    restore() {
      globalThis.window = prevWindow;
      globalThis.document = prevDocument;
      resetGoogleSdkLoaderForTests();
    },
  };
}

test("extractGoogleAppId parses numeric project prefix from OAuth client ID", () => {
  assert.equal(
    extractGoogleAppId("278122127012-gp7trv9f5mn989attqm1t42dlengvrqg.apps.googleusercontent.com"),
    "278122127012",
  );
  assert.equal(extractGoogleAppId("non-numeric-prefix.apps.googleusercontent.com"), "");
  assert.equal(extractGoogleAppId(""), "");
});

test("getGoogleDriveConfig supports explicit NEXT_PUBLIC_GOOGLE_APP_ID and status missing fields", () => {
  const prevClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  const prevApiKey = process.env.NEXT_PUBLIC_GOOGLE_API_KEY;
  const prevAppId = process.env.NEXT_PUBLIC_GOOGLE_APP_ID;
  try {
    process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID = "123456-abc.apps.googleusercontent.com";
    process.env.NEXT_PUBLIC_GOOGLE_API_KEY = "AIzaTestKey";
    delete process.env.NEXT_PUBLIC_GOOGLE_APP_ID;
    assert.equal(isGoogleDrivePickerConfigured(), true);
    assert.deepEqual(getGoogleDriveConfig(), {
      clientId: "123456-abc.apps.googleusercontent.com",
      apiKey: "AIzaTestKey",
      appId: "123456",
    });

    process.env.NEXT_PUBLIC_GOOGLE_APP_ID = "999888777";
    assert.equal(getGoogleDriveConfig().appId, "999888777");

    process.env.NEXT_PUBLIC_GOOGLE_API_KEY = "";
    const status = getGoogleDriveConfigStatus();
    assert.equal(status.configured, false);
    assert.deepEqual(status.missingFields, ["NEXT_PUBLIC_GOOGLE_API_KEY"]);
    assert.ok(status.message?.includes("NEXT_PUBLIC_GOOGLE_API_KEY"));
  } finally {
    if (prevClientId === undefined) delete process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    else process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID = prevClientId;
    if (prevApiKey === undefined) delete process.env.NEXT_PUBLIC_GOOGLE_API_KEY;
    else process.env.NEXT_PUBLIC_GOOGLE_API_KEY = prevApiKey;
    if (prevAppId === undefined) delete process.env.NEXT_PUBLIC_GOOGLE_APP_ID;
    else process.env.NEXT_PUBLIC_GOOGLE_APP_ID = prevAppId;
  }
});

test("ensureGooglePickerSdkLoaded succeeds and removes failed script tags to allow retry after error/timeout", async () => {
  resetGoogleSdkLoaderForTests();
  let attempt = 0;
  const fakeDom = installFakeDomForSdk({
    scriptBehavior: (src) => {
      if (attempt === 0) return "error";
      if (attempt === 1 && src.includes("apis.google.com")) return "hang";
      return "load";
    },
  });

  try {
    // 1st attempt fails on script error -> clears failed script tags
    await assert.rejects(() => ensureGooglePickerSdkLoaded({ timeoutMs: 80 }), /無法載入 Google 外部腳本/);
    assert.equal(getGoogleSdkReadiness(), "error");
    assert.equal(fakeDom.scripts.length, 0);

    // 2nd attempt times out on gapi -> clears failed script tags
    attempt = 1;
    await assert.rejects(() => ensureGooglePickerSdkLoaded({ timeoutMs: 40 }), /逾時/);
    assert.equal(getGoogleSdkReadiness(), "error");
    assert.equal(fakeDom.scripts.some((s) => s._src.includes("apis.google.com")), false);

    // 3rd attempt recovers cleanly
    attempt = 2;
    await ensureGooglePickerSdkLoaded({ timeoutMs: 200 });
    assert.equal(getGoogleSdkReadiness(), "ready");
  } finally {
    fakeDom.restore();
  }
});

test("openGoogleDrivePicker supports multi-select, Shared Drives, resourceKey, and clean cancel", async () => {
  const fakeDom = installFakeDomForSdk();
  try {
    await ensureGooglePickerSdkLoaded({ timeoutMs: 200 });

    const createdViews = [];
    const enabledFeatures = [];
    let nextPickerAction = "picked";
    let builtAppId = "";
    let setVisibleCalled = false;

    globalThis.window.google.picker = {
      ViewId: { DOCS: "DOCS" },
      Action: { PICKED: "picked", CANCEL: "cancel" },
      Feature: { MULTISELECT_ENABLED: "multiselect", SUPPORT_DRIVES: "support_drives" },
      DocsView: class {
        constructor(id) {
          this.viewId = id;
          this.ownedByMe = true;
          this.enableDrives = false;
          this.label = "";
          createdViews.push(this);
        }
        setIncludeFolders() { return this; }
        setSelectFolderEnabled() { return this; }
        setEnableDrives(v) { this.enableDrives = v; return this; }
        setOwnedByMe(v) { this.ownedByMe = v; return this; }
        setMimeTypes() { return this; }
        setLabel(v) { this.label = v; return this; }
      },
      PickerBuilder: class {
        constructor() {
          this.cb = null;
        }
        setTitle() { return this; }
        setOAuthToken() { return this; }
        setDeveloperKey() { return this; }
        setOrigin() { return this; }
        setAppId(id) { builtAppId = id; return this; }
        enableFeature(feat) { enabledFeatures.push(feat); return this; }
        addView() { return this; }
        setCallback(cb) { this.cb = cb; return this; }
        build() {
          const cb = this.cb;
          const action = nextPickerAction;
          return {
            setVisible: (v) => {
              setVisibleCalled = v;
              queueMicrotask(() => {
                if (action === "cancel") {
                  cb?.({ action: "cancel" });
                  return;
                }
                cb?.({
                  action: "picked",
                  docs: [
                    {
                      id: "shared_drive_song_1",
                      name: "worship-shared.mp3",
                      mimeType: "audio/mpeg",
                      sizeBytes: 4096000,
                      resourceKey: "rk-shared-1",
                      driveId: "0ADrive123",
                    },
                    {
                      id: "shared_with_me_2",
                      name: "chorus-demo.wav",
                      mimeType: "audio/wav",
                      sizeBytes: 8192000,
                    },
                  ],
                });
              });
            },
          };
        }
      },
    };

    const picked = await openGoogleDrivePicker({
      accessToken: "token-1",
      apiKey: "api-key-1",
      appId: "278122127012",
      multiple: true,
    });

    assert.equal(setVisibleCalled, true);
    assert.equal(builtAppId, "278122127012");
    assert.ok(enabledFeatures.includes("support_drives"));
    assert.ok(enabledFeatures.includes("multiselect"));
    assert.equal(createdViews.length, 2);
    assert.equal(createdViews.every((v) => v.enableDrives), true);
    assert.equal(picked.length, 2);
    assert.equal(picked[0].resourceKey, "rk-shared-1");
    assert.equal(picked[0].driveId, "0ADrive123");

    // Cancel path
    nextPickerAction = "cancel";
    const cancelled = await openGoogleDrivePicker({
      accessToken: "token-1",
      apiKey: "api-key-1",
      multiple: false,
    });
    assert.deepEqual(cancelled, []);
  } finally {
    fakeDom.restore();
    clearCachedGoogleAccessToken();
  }
});

test("downloadGoogleDriveFile sends resourceKey header, supportsAllDrives, and handles 401/403/404", async () => {
  const payload = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]);
  const progressEvents = [];
  let requestedUrl = "";
  let requestedAuth = "";
  let requestedResourceKeys = "";

  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requestedUrl = String(url);
    requestedAuth = init?.headers?.Authorization ?? "";
    requestedResourceKeys = init?.headers?.["X-Goog-Drive-Resource-Keys"] ?? "";
    return new Response(payload, {
      status: 200,
      headers: {
        "content-type": "audio/mpeg",
        "content-length": String(payload.byteLength),
      },
    });
  };

  try {
    const file = await downloadGoogleDriveFile({
      file: {
        id: "file_123",
        name: "shared-demo.mp3",
        mimeType: "audio/mpeg",
        resourceKey: "rk-99",
      },
      accessToken: "ya29.test-token",
      fileIndex: 0,
      totalFiles: 1,
      onProgress: (p) => progressEvents.push(p),
    });

    assert.equal(
      requestedUrl,
      "https://www.googleapis.com/drive/v3/files/file_123?alt=media&supportsAllDrives=true",
    );
    assert.equal(requestedAuth, "Bearer ya29.test-token");
    assert.equal(requestedResourceKeys, "file_123/rk-99");
    assert.equal(file.name, "shared-demo.mp3");
    assert.equal(file.size, payload.byteLength);
    assert.ok(progressEvents.length >= 2);
  } finally {
    globalThis.fetch = prevFetch;
  }

  // resolveDriveFileForDownload covers shortcut, canDownload=false, trashed, 404
  const resolved = await resolveDriveFileForDownload(
    { id: "sc_1", name: "Shortcut", mimeType: "application/vnd.google-apps.shortcut", resourceKey: "rk-sc" },
    {
      accessToken: "t1",
      fetchImpl: async (url, init) => {
        const u = String(url);
        if (u.includes("/files/sc_1")) {
          assert.equal(init?.headers?.["X-Goog-Drive-Resource-Keys"], "sc_1/rk-sc");
          return new Response(
            JSON.stringify({
              id: "sc_1",
              name: "Shortcut",
              mimeType: "application/vnd.google-apps.shortcut",
              shortcutDetails: { targetId: "target_audio_9", targetResourceKey: "rk-target" },
            }),
            { status: 200 },
          );
        }
        assert.ok(u.includes("/files/target_audio_9"));
        assert.ok(String(init?.headers?.["X-Goog-Drive-Resource-Keys"]).includes("target_audio_9/rk-target"));
        return new Response(
          JSON.stringify({
            id: "target_audio_9",
            name: "band-stem-source.wav",
            mimeType: "audio/wav",
            size: "1234567",
            capabilities: { canDownload: true },
          }),
          { status: 200 },
        );
      },
    },
  );
  assert.equal(resolved.resolvedFileId, "target_audio_9");
  assert.equal(resolved.isShortcut, true);
  assert.equal(resolved.sizeBytes, 1234567);

  await assert.rejects(
    () =>
      resolveDriveFileForDownload(
        { id: "restricted_1", name: "NoDownload.mp3", mimeType: "audio/mpeg" },
        {
          accessToken: "t1",
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                id: "restricted_1",
                name: "NoDownload.mp3",
                mimeType: "audio/mpeg",
                capabilities: { canDownload: false },
              }),
              { status: 200 },
            ),
        },
      ),
    (err) => err instanceof DriveApiError && err.code === "download_restricted",
  );

  await assert.rejects(
    () =>
      resolveDriveFileForDownload(
        { id: "missing_1", name: "Deleted.mp3", mimeType: "audio/mpeg" },
        {
          accessToken: "t1",
          fetchImpl: async () => new Response("Not Found", { status: 404 }),
        },
      ),
    (err) => err instanceof DriveApiError && err.code === "not_found",
  );
});
