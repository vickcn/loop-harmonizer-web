import test from "node:test";
import assert from "node:assert/strict";
import {
  downloadGoogleDriveFile,
  extractGoogleAppId,
  getGoogleDriveConfig,
  isGoogleDrivePickerConfigured,
} from "../lib/google/googleDrivePicker.ts";

test("extractGoogleAppId parses numeric project prefix from OAuth client ID", () => {
  assert.equal(
    extractGoogleAppId("278122127012-gp7trv9f5mn989attqm1t42dlengvrqg.apps.googleusercontent.com"),
    "278122127012"
  );
  assert.equal(extractGoogleAppId("non-numeric-prefix.apps.googleusercontent.com"), "");
  assert.equal(extractGoogleAppId(""), "");
});

test("getGoogleDriveConfig and isGoogleDrivePickerConfigured reflect env vars", () => {
  const prevClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  const prevApiKey = process.env.NEXT_PUBLIC_GOOGLE_API_KEY;
  try {
    process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID = "123456-abc.apps.googleusercontent.com";
    process.env.NEXT_PUBLIC_GOOGLE_API_KEY = "AIzaTestKey";
    assert.equal(isGoogleDrivePickerConfigured(), true);
    assert.deepEqual(getGoogleDriveConfig(), {
      clientId: "123456-abc.apps.googleusercontent.com",
      apiKey: "AIzaTestKey",
      appId: "123456",
    });

    process.env.NEXT_PUBLIC_GOOGLE_API_KEY = "";
    assert.equal(isGoogleDrivePickerConfigured(), false);
  } finally {
    if (prevClientId === undefined) delete process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    else process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID = prevClientId;
    if (prevApiKey === undefined) delete process.env.NEXT_PUBLIC_GOOGLE_API_KEY;
    else process.env.NEXT_PUBLIC_GOOGLE_API_KEY = prevApiKey;
  }
});

test("downloadGoogleDriveFile downloads binary payload with supportsAllDrives and reports progress", async () => {
  const prevFetch = globalThis.fetch;
  const payload = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]);
  const progressEvents = [];
  let requestedUrl = "";
  let requestedAuth = "";

  globalThis.fetch = async (url, init) => {
    requestedUrl = String(url);
    requestedAuth = init?.headers?.Authorization ?? "";
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
      file: { id: "file_123", name: "shared-demo.mp3", mimeType: "audio/mpeg" },
      accessToken: "ya29.test-token",
      fileIndex: 0,
      totalFiles: 1,
      onProgress: (p) => progressEvents.push(p),
    });

    assert.equal(
      requestedUrl,
      "https://www.googleapis.com/drive/v3/files/file_123?alt=media&supportsAllDrives=true"
    );
    assert.equal(requestedAuth, "Bearer ya29.test-token");
    assert.equal(file.name, "shared-demo.mp3");
    assert.equal(file.type, "audio/mpeg");
    assert.equal(file.size, payload.byteLength);
    assert.ok(progressEvents.length >= 2);
    assert.equal(progressEvents[progressEvents.length - 1].loadedBytes, payload.byteLength);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("downloadGoogleDriveFile throws helpful errors on 401 and 403", async () => {
  const prevFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("Unauthorized", { status: 401 });
    await assert.rejects(
      () =>
        downloadGoogleDriveFile({
          file: { id: "f1", name: "track.wav", mimeType: "audio/wav" },
          accessToken: "expired",
          fileIndex: 0,
          totalFiles: 1,
        }),
      /授權已過期/
    );

    globalThis.fetch = async () => new Response("Forbidden", { status: 403 });
    await assert.rejects(
      () =>
        downloadGoogleDriveFile({
          file: { id: "f2", name: "track.wav", mimeType: "audio/wav" },
          accessToken: "valid",
          fileIndex: 0,
          totalFiles: 1,
        }),
      /無法存取「track\.wav」/
    );
  } finally {
    globalThis.fetch = prevFetch;
  }
});
