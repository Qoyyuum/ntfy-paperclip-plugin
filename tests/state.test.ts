import { test, expect } from "bun:test";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { manifest } from "../src/manifest";
import { loadState, saveChannels, saveSubscriptions } from "../src/state";

const COMPANY = "company-1";

function harness() {
  return createTestHarness({ manifest });
}

test("loadState returns empty defaults for unknown company", async () => {
  const h = harness();
  expect(await loadState(h.ctx, COMPANY)).toEqual({
    channels: [],
    subscriptions: [],
  });
});

test("channels and subscriptions round-trip", async () => {
  const h = harness();
  const channels = [
    { id: "ch1", name: "Incidents", topic: "acme-incidents", categories: ["issues"], priority: 5 },
  ];
  const subs = [{ principalId: "u1", principalType: "user" as const, channelId: "ch1" }];
  await saveChannels(h.ctx, COMPANY, channels);
  await saveSubscriptions(h.ctx, COMPANY, subs);
  const state = await loadState(h.ctx, COMPANY);
  expect(state.channels).toEqual(channels);
  expect(state.subscriptions).toEqual(subs);
});

test("loadState drops malformed entries", async () => {
  const h = harness();
  await h.ctx.state.set(
    { scopeKind: "company", scopeId: COMPANY, stateKey: "channels" },
    [{ id: "ok", name: "n", topic: "t", categories: ["issues"] }, { name: "no-topic" }, "junk", null],
  );
  await h.ctx.state.set(
    { scopeKind: "company", scopeId: COMPANY, stateKey: "subscriptions" },
    [{ principalId: "u1", principalType: "user", channelId: "ok" }, { channelId: "ok" }, 42],
  );
  const state = await loadState(h.ctx, COMPANY);
  expect(state.channels).toHaveLength(1);
  expect(state.channels[0]!.topic).toBe("t");
  expect(state.subscriptions).toHaveLength(1);
});

test("state is scoped per company", async () => {
  const h = harness();
  await saveChannels(h.ctx, "c1", [
    { id: "a", name: "n", topic: "t1", categories: ["issues"] },
  ]);
  expect((await loadState(h.ctx, "c2")).channels).toEqual([]);
});
