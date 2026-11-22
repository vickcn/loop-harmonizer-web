import test from "node:test";
import assert from "node:assert/strict";
import {
  GOOGLE_DRIVE_FILE_SCOPE,
  GOOGLE_IDENTITY_SCOPES,
  GOOGLE_REQUESTED_SCOPES,
} from "../lib/google/googleAuthTypes.ts";
import {
  GoogleAccountManager,
  isGoogleTokenSnapshotUsable,
} from "../lib/google/googleAccountManager.ts";
import { configureInMemoryIdbForTests, resetInMemoryIdbForTests } from "../lib/storage/indexedDb.ts";

function makeManager(overrides = {}) {
  let nowMs = 1_700_000_000_000;
  const revokedTokens = [];
  const requestedOptions = [];

  const manager = new GoogleAccountManager({
    getConfigStatus: () => ({
      configured: true,
      clientId: "278122127012-abc.apps.googleusercontent.com",
      apiKey: "AIzaFake",
      appId: "278122127012",
      missingFields: [],
      message: null,
    }),
    ensureSdkLoaded: async () => {},
    getSdkReadiness: () => "ready",
    subscribeSdkReadiness: () => () => {},
    now: () => nowMs,
    revokeToken: async (token) => {
      revokedTokens.push(token);
    },
    requestAccessToken: async (_clientId, opts) => {
      requestedOptions.push(opts ?? {});
      return {
        accessToken: "token-account-a",
        expiresInSec: 3600,
        grantedScopes: [GOOGLE_DRIVE_FILE_SCOPE, ...GOOGLE_IDENTITY_SCOPES],
      };
    },
    fetchImpl: async (url) => {
      if (String(url).includes("/oauth2/v3/userinfo")) {
        return new Response(
          JSON.stringify({
            sub: "110022003300",
            email: "band-member@example.com",
            name: "Band Member",
            picture: "https://example.com/a.png",
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    },
    ...overrides,
  });

  return {
    manager,
    revokedTokens,
    requestedOptions,
    advanceTime: (ms) => {
      nowMs += ms;
    },
  };
}

test("Google OAuth uses least-privilege drive.file + openid/profile/email scopes only", () => {
  const scopes = GOOGLE_REQUESTED_SCOPES.split(/\s+/);
  assert.ok(scopes.includes("https://www.googleapis.com/auth/drive.file"));
  assert.ok(scopes.includes("openid"));
  assert.ok(scopes.includes("profile"));
  assert.ok(scopes.includes("email"));
  assert.equal(scopes.includes("https://www.googleapis.com/auth/drive"), false);
  assert.equal(scopes.includes("https://www.googleapis.com/auth/drive.readonly"), false);
  assert.equal(scopes.some((s) => s.includes("gmail") || s.includes("calendar")), false);
});

test("GoogleAccountManager signs in with immutable sub ID, keeps token only in memory, and handles expiry", async () => {
  configureInMemoryIdbForTests();
  try {
    const { manager, advanceTime } = makeManager();
    const snap = await manager.signIn();

    assert.equal(snap.status, "signed_in");
    assert.equal(snap.account?.accountId, "google:110022003300");
    assert.equal(snap.account?.email, "band-member@example.com");
    assert.equal(manager.getValidAccessToken("google:110022003300"), "token-account-a");
    // Snapshot exposes no token
    assert.equal("accessToken" in snap, false);

    // Expiring token invalidates getValidAccessToken cleanly
    advanceTime(3_550_000);
    assert.equal(manager.getValidAccessToken("google:110022003300"), null);
    assert.equal(manager.getSnapshot().status, "expired");

    manager.markTokenExpired(undefined, "Token revoked remotely");
    assert.equal(manager.getSnapshot().status, "expired");
    manager.dispose();
  } finally {
    resetInMemoryIdbForTests();
  }
});

test("token snapshot validity is a pure render-safe read and expiry is applied outside the read", async () => {
  const { manager, advanceTime } = makeManager();
  let notifications = 0;
  const unsubscribe = manager.subscribe(() => {
    notifications += 1;
  });
  const signedIn = await manager.signIn();
  const notificationBaseline = notifications;

  assert.equal(manager.getValidAccessToken("google:other-account"), null);
  assert.equal(manager.getSnapshot().status, "signed_in", "account mismatch must not expire this session");

  assert.equal(isGoogleTokenSnapshotUsable(signedIn, signedIn.expiresAt - 60_001), true);
  assert.equal(isGoogleTokenSnapshotUsable(signedIn, signedIn.expiresAt - 60_000), false);
  assert.equal(manager.getSnapshot().status, "signed_in");
  assert.equal(notifications, notificationBaseline, "pure snapshot read must not notify subscribers");

  advanceTime(3_550_000);
  assert.equal(manager.getValidAccessToken(signedIn.account.accountId), null);
  assert.equal(manager.getSnapshot().status, "expired");
  unsubscribe();
  manager.dispose();
});

test("GoogleAccountManager falls back to Drive about.user.permissionId when userinfo fails", async () => {
  const { manager } = makeManager({
    requestAccessToken: async () => ({
      accessToken: "token-about-only",
      expiresInSec: 3600,
      grantedScopes: [GOOGLE_DRIVE_FILE_SCOPE],
    }),
    fetchImpl: async (url) => {
      assert.ok(String(url).includes("/drive/v3/about"));
      return new Response(
        JSON.stringify({
          user: {
            permissionId: "perm-998877",
            displayName: "Drummer",
            emailAddress: "drummer@example.com",
          },
        }),
        { status: 200 },
      );
    },
  });

  const snap = await manager.signIn();
  assert.equal(snap.account?.accountId, "drive:perm-998877");
  manager.dispose();
});

test("signOut keeps remote grant intact whereas revokeAuthorization revokes token and notifies listeners", async () => {
  const { manager, revokedTokens } = makeManager();
  const events = [];
  manager.onAccountSessionEnd((ev) => events.push(ev));

  await manager.signIn();
  await manager.signOut();
  assert.equal(revokedTokens.length, 0);
  assert.equal(manager.getSnapshot().status, "signed_out");
  assert.equal(manager.getSnapshot().account, null);
  assert.equal(events[0]?.reason, "signed_out");

  await manager.signIn();
  await manager.revokeAuthorization();
  assert.deepEqual(revokedTokens, ["token-account-a"]);
  assert.equal(manager.getSnapshot().status, "revoked");
  assert.equal(events[1]?.reason, "revoked");
  manager.dispose();
});

test("Popup cancel does not leave authorizing state stuck and preserves prior state", async () => {
  const { manager } = makeManager({
    requestAccessToken: async () => {
      throw new Error("使用者取消了 Google 登入授權。");
    },
  });

  await assert.rejects(() => manager.signIn(), /取消/);
  const snap = manager.getSnapshot();
  assert.equal(snap.status, "signed_out");
  assert.equal(snap.account, null);
  manager.dispose();
});

test("switchAccount updates generation and prevents stale Account A async callbacks from polluting Account B", async () => {
  let activePersona = "A";
  let resolveAUserInfo = null;
  const capturedRequestOpts = [];

  const { manager } = makeManager({
    requestAccessToken: async (_clientId, opts) => {
      capturedRequestOpts.push(opts ?? {});
      return {
        accessToken: activePersona === "A" ? "token-A" : "token-B",
        expiresInSec: 3600,
        grantedScopes: [GOOGLE_DRIVE_FILE_SCOPE, "openid", "profile", "email"],
      };
    },
    fetchImpl: async (_url) => {
      if (activePersona === "A") {
        // Delayed response for Account A
        await new Promise((resolve) => {
          resolveAUserInfo = resolve;
        });
        return new Response(
          JSON.stringify({ sub: "sub-AAA", email: "a@example.com", name: "User A" }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ sub: "sub-BBB", email: "b@example.com", name: "User B" }),
        { status: 200 },
      );
    },
  });

  // Start Account A signIn (stalls on userinfo)
  const pendingA = manager.signIn().catch((err) => err);
  await new Promise((r) => setTimeout(r, 15));

  // Switch immediately to Account B before Account A userinfo resolves
  activePersona = "B";
  const bSnap = await manager.switchAccount();
  assert.equal(bSnap.status, "signed_in");
  assert.equal(bSnap.account?.accountId, "google:sub-BBB");
  assert.equal(capturedRequestOpts[capturedRequestOpts.length - 1]?.prompt, "select_account");
  const genB = bSnap.generation;

  // Now Account A's slow userinfo finally arrives
  resolveAUserInfo?.();
  await pendingA;

  // Account B must remain intact and Account A must NOT overwrite snapshot or token
  const finalSnap = manager.getSnapshot();
  assert.equal(finalSnap.account?.accountId, "google:sub-BBB");
  assert.equal(finalSnap.generation, genB);
  assert.equal(manager.getValidAccessToken("google:sub-BBB"), "token-B");
  assert.equal(manager.getValidAccessToken("google:sub-AAA"), null);
  assert.equal(manager.isGenerationValid(genB - 1, "google:sub-AAA"), false);
  manager.dispose();
});
