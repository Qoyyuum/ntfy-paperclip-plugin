import { test, expect, beforeAll, afterAll } from "bun:test";
import { publish, healthCheck } from "../src/ntfy";

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
const requests: Array<{
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}> = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => (headers[k] = v));
      const body = await req.text();
      requests.push({ method: req.method, path: url.pathname, headers, body });
      if (url.pathname === "/v1/health") return Response.json({ healthy: true });
      if (url.pathname === "/fail") return new Response("nope", { status: 500 });
      if (url.pathname === "/authed-health") {
        return headers.authorization
          ? Response.json({ healthy: true })
          : new Response("unauthorized", { status: 401 });
      }
      return Response.json({ id: "abc" });
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => server.stop(true));

test("publish POSTs to {baseUrl}/{topic} with ntfy headers", async () => {
  requests.length = 0;
  await publish(fetch, {
    baseUrl: baseUrl + "/",
    topic: "mytopic",
    authHeader: "Bearer tk_x",
    title: "Issue PAP-1 created",
    body: "Alice opened the issue",
    priority: 4,
    tags: "paperclip,issue",
    click: "https://app.example/PAP/issues/PAP-1",
  });
  expect(requests).toHaveLength(1);
  const r = requests[0]!;
  expect(r.method).toBe("POST");
  expect(r.path).toBe("/mytopic");
  expect(r.headers.authorization).toBe("Bearer tk_x");
  expect(r.headers.title).toBe("Issue PAP-1 created");
  expect(r.headers.priority).toBe("4");
  expect(r.headers.tags).toBe("paperclip,issue");
  expect(r.headers.click).toBe("https://app.example/PAP/issues/PAP-1");
  expect(r.body).toBe("Alice opened the issue");
});

test("publish omits optional headers when unset", async () => {
  requests.length = 0;
  await publish(fetch, {
    baseUrl,
    topic: "t2",
    authHeader: null,
    title: "hi",
    body: "b",
  });
  expect(requests[0]!.headers.authorization).toBeUndefined();
  expect(requests[0]!.headers.priority).toBeUndefined();
  expect(requests[0]!.headers.click).toBeUndefined();
});

test("publish throws on non-2xx", async () => {
  expect(
    publish(fetch, {
      baseUrl,
      topic: "fail",
      authHeader: null,
      title: "t",
      body: "b",
    }),
  ).rejects.toThrow(/500/);
});

test("healthCheck reports up / auth-required / unreachable", async () => {
  expect(await healthCheck(fetch, baseUrl, null)).toBe("up");
  const s2 = Bun.serve({
    port: 0,
    fetch: () => new Response("unauthorized", { status: 401 }),
  });
  expect(await healthCheck(fetch, `http://localhost:${s2.port}`, null)).toBe(
    "auth-required",
  );
  s2.stop(true);
  expect(await healthCheck(fetch, "http://localhost:1", null, 500)).toBe(
    "unreachable",
  );
});
