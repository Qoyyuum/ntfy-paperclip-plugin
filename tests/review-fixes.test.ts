import { test, expect, beforeAll, afterAll } from "bun:test";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type {
  PluginAccessMember,
  PluginApiRequestInput,
} from "@paperclipai/plugin-sdk";
import { manifest } from "../src/manifest";
import { handleApiRequest, type RouteDeps } from "../src/routes";
import { runSetup, type ExecFn } from "../src/server-setup";
import { publish } from "../src/ntfy";
import plugin from "../src/worker";

const COMPANY = "c1";
const ADMIN = "u-admin";

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

function harness(config: Record<string, unknown> = {}) {
  const h = createTestHarness({ manifest, config });
  h.seed({
    accessMembers: [member({ principalId: ADMIN, membershipRole: "owner" })],
  });
  return h;
}

function deps(): RouteDeps {
  return { fetchFn: fetch, exec: async () => ({ stdout: "", stderr: "" }) };
}

// --- Critical #1: two "new" channel creates must not collide ---

test("two channel creates via 'new' produce two distinct channels", async () => {
  const h = harness();
  for (const name of ["one", "two"]) {
    const res = await handleApiRequest(
      h.ctx,
      req("channel-upsert", {
        userId: ADMIN,
        params: { id: "new" },
        body: {
          companyId: COMPANY,
          name,
          topic: `t-${name}`,
          categories: ["issues"],
        },
      }),
      deps(),
    );
    expect(res.status).toBe(200);
  }
  const state = (
    await handleApiRequest(h.ctx, req("admin-state", { userId: ADMIN }), deps())
  ).body as { channels: Array<{ id: string; name: string }> };
  expect(state.channels).toHaveLength(2);
  expect(state.channels[0]!.id).not.toBe(state.channels[1]!.id);
});

// --- Important: port validation for compose-up ---

function fakeExec(map: Record<string, string | Error>) {
  const calls: string[] = [];
  const fn: ExecFn = async (cmd, args) => {
    const key = [cmd, ...args].join(" ");
    calls.push(key);
    for (const [k, v] of Object.entries(map)) {
      if (key.includes(k)) {
        if (v instanceof Error) throw v;
        return { stdout: v, stderr: "" };
      }
    }
    throw new Error("command not found: " + key);
  };
  return { calls, fn };
}

test("compose-up rejects invalid or injection-prone port values", async () => {
  for (const port of [
    "2580\"\n    network_mode: host\n    #" as unknown as number,
    0,
    70000,
    3.14,
    NaN,
  ]) {
    const res = await runSetup(
      { op: "compose-up", runtime: "docker", port },
      { exec: async () => ({ stdout: "", stderr: "" }) },
    );
    expect(res.status).toBe(400);
  }
});

// --- Important: start-container only starts probed ntfy containers ---

test("start-container rejects a container id not in the probed stopped list", async () => {
  const { calls, fn } = fakeExec({
    "command -v docker": "/usr/bin/docker",
    "docker compose version": "2.20",
    "docker ps -a --format": "abc123 ntfy\n",
    "docker inspect": "exited",
    "docker start": "",
  });
  const bad = await runSetup(
    { op: "start-container", runtime: "docker", containerId: "deadbeef" },
    { exec: fn, checkHealth: async () => "unreachable" },
  );
  expect(bad.status).toBe(400);
  expect(calls.some((c) => c.includes("docker start deadbeef"))).toBe(false);

  const good = await runSetup(
    { op: "start-container", runtime: "docker", containerId: "abc123" },
    { exec: fn, checkHealth: async () => "up" },
  );
  expect(good.status).toBe(200);
  expect(calls.some((c) => c.includes("docker start abc123"))).toBe(true);
});

// --- Important: non-ASCII values must not kill the publish ---

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
const posts: Array<{ path: string; headers: Record<string, string>; body: string }> = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => (headers[k] = v));
      posts.push({
        path: new URL(req.url).pathname,
        headers,
        body: await req.text(),
      });
      return Response.json({ id: "x" });
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => server.stop(true));

test("publish handles non-ASCII title and tags", async () => {
  posts.length = 0;
  await publish(fetch, {
    baseUrl,
    topic: "t1",
    authHeader: null,
    title: "New issue 🔥 Ünïcode",
    body: "body",
    tags: "fire,🔥",
  });
  expect(posts).toHaveLength(1);
});

// --- Minor: resolveAuth failures return structured errors, not throws ---

test("server-status degrades to config-error instead of throwing", async () => {
  const h = harness({ authMode: "token" }); // missing accessTokenSecretId
  const res = await handleApiRequest(
    h.ctx,
    req("server-status", { userId: ADMIN, query: { companyId: COMPANY } }),
    deps(),
  );
  expect(res.status).toBe(200);
  expect((res.body as Record<string, unknown>).status).toBe("config-error");
});

test("test-send returns an error response when auth is misconfigured", async () => {
  const h = harness({ authMode: "token" });
  await handleApiRequest(
    h.ctx,
    req("channel-upsert", {
      userId: ADMIN,
      params: { id: "new" },
      body: {
        companyId: COMPANY,
        name: "n",
        topic: "t",
        categories: ["issues"],
      },
    }),
    deps(),
  );
  const state = (
    await handleApiRequest(h.ctx, req("admin-state", { userId: ADMIN }), deps())
  ).body as { channels: Array<{ id: string }> };
  const res = await handleApiRequest(
    h.ctx,
    req("test-send", {
      userId: ADMIN,
      body: { companyId: COMPANY, channelId: state.channels[0]!.id },
    }),
    deps(),
  );
  expect(res.status).toBe(500);
  expect((res.body as Record<string, unknown>).error).toContain(
    "accessTokenSecretId",
  );
});

// --- Minor: event handler must not reject when config/state reads throw ---

test("worker event handler logs errors instead of rejecting", async () => {
  const h = createTestHarness({
    manifest,
    config: { baseUrl: "https://ntfy.example" },
  });
  await plugin.definition.setup(h.ctx);
  // sabotage config reads so dispatchEvent throws before publish
  const origGet = h.ctx.config.get;
  h.ctx.config.get = async () => {
    throw new Error("config store down");
  };
  await h.emit("issue.created", {}, { companyId: COMPANY });
  h.ctx.config.get = origGet;
  expect(
    h.logs.some(
      (l) => l.level === "error" && String(l.message).includes("config store down") === false,
    ),
  ).toBe(true);
});

// --- Minor: channel priority must be an integer 1..5 ---

test("channel-upsert rejects out-of-range priority", async () => {
  const h = harness();
  const res = await handleApiRequest(
    h.ctx,
    req("channel-upsert", {
      userId: ADMIN,
      params: { id: "new" },
      body: {
        companyId: COMPANY,
        name: "n",
        topic: "t",
        categories: ["issues"],
        priority: 9,
      },
    }),
    deps(),
  );
  expect(res.status).toBe(400);
});

// --- Minor: subscriptions dedupe + principal must be an active member ---

test("subscriptions-set dedupes channelIds and rejects non-members", async () => {
  const h = harness();
  await handleApiRequest(
    h.ctx,
    req("channel-upsert", {
      userId: ADMIN,
      params: { id: "new" },
      body: {
        companyId: COMPANY,
        name: "n",
        topic: "t",
        categories: ["issues"],
      },
    }),
    deps(),
  );
  const state = (
    await handleApiRequest(h.ctx, req("admin-state", { userId: ADMIN }), deps())
  ).body as { channels: Array<{ id: string }> };
  const chId = state.channels[0]!.id;

  const notMember = await handleApiRequest(
    h.ctx,
    req("subscriptions-set", {
      userId: ADMIN,
      body: {
        companyId: COMPANY,
        principalId: "u-stranger",
        principalType: "user",
        channelIds: [chId],
      },
    }),
    deps(),
  );
  expect(notMember.status).toBe(400);

  const dup = await handleApiRequest(
    h.ctx,
    req("subscriptions-set", {
      userId: ADMIN,
      body: {
        companyId: COMPANY,
        principalId: ADMIN,
        principalType: "user",
        channelIds: [chId, chId],
      },
    }),
    deps(),
  );
  expect(dup.status).toBe(200);
  const after = (
    await handleApiRequest(h.ctx, req("admin-state", { userId: ADMIN }), deps())
  ).body as { subscriptions: Array<unknown> };
  expect(after.subscriptions).toHaveLength(1);
});
