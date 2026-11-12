import { test, expect } from "bun:test";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { manifest } from "../src/manifest";
import plugin from "../src/worker";
import { saveChannels } from "../src/state";

const COMPANY = "c1";

test("worker publishes on issue.created after setup", async () => {
  const h = createTestHarness({
    manifest,
    config: { baseUrl: "https://ntfy.example" },
  });
  await saveChannels(h.ctx, COMPANY, [
    { id: "a", name: "a", topic: "t-issues", categories: ["issues"] },
  ]);
  const posts: string[] = [];
  h.ctx.http.fetch = async (url: string) => {
    posts.push(url);
    return new Response("ok");
  };
  await plugin.definition.setup(h.ctx);
  await h.emit("issue.created", {}, { companyId: COMPANY, entityId: "i1", entityType: "issue" });
  expect(posts).toEqual(["https://ntfy.example/t-issues"]);
});

test("onValidateConfig flags bad auth combos and warns on missing appBaseUrl", async () => {
  const bad = await plugin.definition.onValidateConfig!({
    baseUrl: "https://ntfy.sh",
    authMode: "token",
  });
  expect(bad.ok).toBe(false);
  expect(bad.errors!.join(" ")).toContain("accessTokenSecretId");

  const warns = await plugin.definition.onValidateConfig!({
    baseUrl: "https://ntfy.sh",
    authMode: "none",
  });
  expect(warns.ok).toBe(true);
  expect(warns.warnings!.join(" ")).toContain("appBaseUrl");

  const invalid = await plugin.definition.onValidateConfig!({
    baseUrl: "not a url",
  });
  expect(invalid.ok).toBe(false);
});

test("onHealth reports ok without company calls", async () => {
  const health = await plugin.definition.onHealth!();
  expect(health.status).toBe("ok");
});
