import { test, expect } from "bun:test";
import { parseConfig, buildAuthHeader } from "../src/config";

test("parseConfig fills defaults", () => {
  const cfg = parseConfig({});
  expect(cfg.baseUrl).toBe("https://ntfy.sh");
  expect(cfg.authMode).toBe("none");
  expect(cfg.defaultPriority).toBe(3);
  expect(cfg.appBaseUrl).toBeNull();
});

test("parseConfig treats blank baseUrl as default and strips trailing slash", () => {
  expect(parseConfig({ baseUrl: "   " }).baseUrl).toBe("https://ntfy.sh");
  expect(parseConfig({ baseUrl: "https://x.io/" }).baseUrl).toBe("https://x.io");
  expect(parseConfig({ appBaseUrl: "https://app.example/" }).appBaseUrl).toBe(
    "https://app.example",
  );
});

test("parseConfig clamps priority to 1-5", () => {
  expect(parseConfig({ defaultPriority: 9 }).defaultPriority).toBe(5);
  expect(parseConfig({ defaultPriority: 0 }).defaultPriority).toBe(1);
});

test("buildAuthHeader token mode resolves secret_ref", async () => {
  const calls: unknown[] = [];
  const header = await buildAuthHeader(
    parseConfig({ authMode: "token", accessTokenSecretId: "sid1" }),
    async (ref) => {
      calls.push(ref);
      return "tk_abc";
    },
    "company-1",
  );
  expect(header).toBe("Bearer tk_abc");
  expect(calls[0]).toEqual({ type: "secret_ref", secretId: "sid1" });
});

test("buildAuthHeader basic mode builds Basic credentials", async () => {
  const header = await buildAuthHeader(
    parseConfig({
      authMode: "basic",
      username: "user",
      passwordSecretId: "pwsec",
    }),
    async () => "pass",
    "company-1",
  );
  expect(header).toBe("Basic dXNlcjpwYXNz");
});

test("buildAuthHeader none mode returns null", async () => {
  const header = await buildAuthHeader(
    parseConfig({}),
    async () => "x",
    "company-1",
  );
  expect(header).toBeNull();
});

test("buildAuthHeader throws when required secret id missing", async () => {
  expect(
    buildAuthHeader(parseConfig({ authMode: "token" }), async () => "x", "c"),
  ).rejects.toThrow(/accessTokenSecretId/);
  expect(
    buildAuthHeader(
      parseConfig({ authMode: "basic", username: "u" }),
      async () => "x",
      "c",
    ),
  ).rejects.toThrow(/passwordSecretId/);
});
