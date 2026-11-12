import { test, expect, beforeAll, afterAll } from "bun:test";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type {
  PluginAccessMember,
  PluginApiRequestInput,
} from "@paperclipai/plugin-sdk";
import { manifest } from "../src/manifest";
import { handleApiRequest, type RouteDeps } from "../src/routes";

const COMPANY = "c1";
const ADMIN = "u-admin";
const VIEWER = "u-viewer";

function member(partial: Partial<PluginAccessMember>): PluginAccessMember {
  return {
    id: "m-" + (partial.principalId ?? "x"),
    companyId: COMPANY,
    principalType: "user",
    principalId: "u-x",
    status: "active",
    membershipRole: "member",
    grants: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  };
}

function req(
  routeKey: string,
  opts: {
    userId?: string | null;
    body?: unknown;
    params?: Record<string, string>;
    query?: Record<string, string>;
  } = {},
): PluginApiRequestInput {
  return {
    routeKey,
    method: "GET",
    path: "/",
    params: opts.params ?? {},
    query: opts.query ?? {},
    body: opts.body ?? {},
    actor: {
      actorType: "user",
      actorId: opts.userId ?? "anon",
      userId: opts.userId ?? null,
    },
    companyId: COMPANY,
    headers: {},
  };
}

function harness() {
  const h = createTestHarness({
    manifest,
    config: { baseUrl },
  });
  h.seed({
    accessMembers: [
      member({ principalId: ADMIN, membershipRole: "owner" }),
      member({ principalId: VIEWER, membershipRole: "viewer" }),
      member({ principalId: "ag1", principalType: "agent" }),
    ],
  });
  return h;
}

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
const posts: string[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      posts.push(new URL(req.url).pathname);
      return Response.json({ healthy: true });
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => server.stop(true));

function deps(): RouteDeps {
  return { fetchFn: fetch, exec: async () => ({ stdout: "", stderr: "" }) };
}

test("non-admin gets 403 on reads and mutations", async () => {
  const h = harness();
  const read = await handleApiRequest(
    h.ctx,
    req("admin-state", { userId: VIEWER }),
    deps(),
  );
  expect(read.status).toBe(403);
  expect((read.body as Record<string, unknown>).error).toBe("admin_required");

  const write = await handleApiRequest(
    h.ctx,
    req("channel-upsert", {
      userId: VIEWER,
      params: { id: "x" },
      body: { companyId: COMPANY, name: "n", topic: "t", categories: ["issues"] },
    }),
    deps(),
  );
  expect(write.status).toBe(403);
});

test("admin channel upsert then visible in admin-state", async () => {
  const h = harness();
  const put = await handleApiRequest(
    h.ctx,
    req("channel-upsert", {
      userId: ADMIN,
      params: { id: "ch1" },
      body: {
        companyId: COMPANY,
        name: "Incidents",
        topic: "acme-incidents",
        categories: ["issues", "budget"],
        priority: 5,
      },
    }),
    deps(),
  );
  expect(put.status).toBe(200);

  const state = await handleApiRequest(
    h.ctx,
    req("admin-state", { userId: ADMIN }),
    deps(),
  );
  const body = state.body as {
    channels: Array<{ id: string; topic: string }>;
    members: Array<{ principalId: string }>;
  };
  expect(body.channels).toHaveLength(1);
  expect(body.channels[0]!.topic).toBe("acme-incidents");
  expect(body.members.map((m) => m.principalId)).toContain(ADMIN);
});

test("channel upsert rejects unknown category", async () => {
  const h = harness();
  const res = await handleApiRequest(
    h.ctx,
    req("channel-upsert", {
      userId: ADMIN,
      params: { id: "ch1" },
      body: {
        companyId: COMPANY,
        name: "n",
        topic: "t",
        categories: ["issues", "bogus"],
      },
    }),
    deps(),
  );
  expect(res.status).toBe(400);
});

test("subscriptions-set rejects unknown channelId; valid set replaces", async () => {
  const h = harness();
  await handleApiRequest(
    h.ctx,
    req("channel-upsert", {
      userId: ADMIN,
      params: { id: "ch1" },
      body: { companyId: COMPANY, name: "n", topic: "t", categories: ["issues"] },
    }),
    deps(),
  );
  const bad = await handleApiRequest(
    h.ctx,
    req("subscriptions-set", {
      userId: ADMIN,
      body: {
        companyId: COMPANY,
        principalId: "u-target",
        principalType: "user",
        channelIds: ["nope"],
      },
    }),
    deps(),
  );
  expect(bad.status).toBe(400);

  const good = await handleApiRequest(
    h.ctx,
    req("subscriptions-set", {
      userId: ADMIN,
      body: {
        companyId: COMPANY,
        principalId: "u-target",
        principalType: "user",
        channelIds: ["ch1"],
      },
    }),
    deps(),
  );
  expect(good.status).toBe(200);
  const state = (await handleApiRequest(h.ctx, req("admin-state", { userId: ADMIN }), deps()))
    .body as { subscriptions: Array<{ principalId: string; channelId: string }> };
  expect(state.subscriptions).toEqual([
    { principalId: "u-target", principalType: "user", channelId: "ch1" },
  ]);
});

test("channel-delete removes channel and its subscriptions", async () => {
  const h = harness();
  await handleApiRequest(
    h.ctx,
    req("channel-upsert", {
      userId: ADMIN,
      params: { id: "ch1" },
      body: { companyId: COMPANY, name: "n", topic: "t", categories: ["issues"] },
    }),
    deps(),
  );
  await handleApiRequest(
    h.ctx,
    req("subscriptions-set", {
      userId: ADMIN,
      body: {
        companyId: COMPANY,
        principalId: "u1",
        principalType: "user",
        channelIds: ["ch1"],
      },
    }),
    deps(),
  );
  const del = await handleApiRequest(
    h.ctx,
    req("channel-delete", { userId: ADMIN, params: { id: "ch1" } }),
    deps(),
  );
  expect(del.status).toBe(200);
  const state = (await handleApiRequest(h.ctx, req("admin-state", { userId: ADMIN }), deps()))
    .body as { channels: unknown[]; subscriptions: unknown[] };
  expect(state.channels).toEqual([]);
  expect(state.subscriptions).toEqual([]);
});

test("test-send publishes a test message to the channel topic", async () => {
  posts.length = 0;
  const h = harness();
  await handleApiRequest(
    h.ctx,
    req("channel-upsert", {
      userId: ADMIN,
      params: { id: "ch1" },
      body: { companyId: COMPANY, name: "n", topic: "test-topic", categories: ["issues"] },
    }),
    deps(),
  );
  const res = await handleApiRequest(
    h.ctx,
    req("test-send", {
      userId: ADMIN,
      body: { companyId: COMPANY, channelId: "ch1" },
    }),
    deps(),
  );
  expect(res.status).toBe(200);
  expect(posts).toContain("/test-topic");
});

test("unknown routeKey returns 404", async () => {
  const h = harness();
  const res = await handleApiRequest(
    h.ctx,
    req("nope", { userId: ADMIN }),
    deps(),
  );
  expect(res.status).toBe(404);
});
