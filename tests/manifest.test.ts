import { test, expect } from "bun:test";
import { manifest } from "../src/manifest";

test("manifest id and apiVersion", () => {
  expect(manifest.id).toBe("paperclip.ntfy");
  expect(manifest.apiVersion).toBe(1);
});

test("all admin apiRoutes are board-authed and capability-gated", () => {
  expect(manifest.apiRoutes).toHaveLength(7);
  for (const route of manifest.apiRoutes ?? []) {
    expect(route.capability).toBe("api.routes.register");
    expect(route.auth).toBe("board");
  }
  const keys = (manifest.apiRoutes ?? []).map((r) => r.routeKey);
  expect(keys.sort()).toEqual([
    "admin-state",
    "channel-delete",
    "channel-upsert",
    "server-setup",
    "server-status",
    "subscriptions-set",
    "test-send",
  ]);
});

test("page slot exports NotificationsAdminPage", () => {
  const slot = manifest.ui?.slots?.find((s) => s.id === "notifications-admin");
  expect(slot?.type).toBe("page");
  expect(slot?.exportName).toBe("NotificationsAdminPage");
});
