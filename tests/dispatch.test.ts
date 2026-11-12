import { test, expect } from "bun:test";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { manifest } from "../src/manifest";
import { dispatchEvent } from "../src/dispatch";
import { categoryFor, formatEvent } from "../src/events";
import { saveChannels } from "../src/state";
import type { PluginEvent } from "@paperclipai/plugin-sdk";

const COMPANY = "c1";

function event(type: string, partial: Partial<PluginEvent> = {}): PluginEvent {
  return {
    eventId: "e1",
    eventType: type as PluginEvent["eventType"],
    occurredAt: new Date().toISOString(),
    companyId: COMPANY,
    entityId: "iss-1",
    entityType: "issue",
    payload: {},
    ...partial,
  };
}

function setupHarness(channels: Parameters<typeof saveChannels>[2]) {
  const h = createTestHarness({
    manifest,
    config: { baseUrl: "https://ntfy.example", appBaseUrl: "https://app.example" },
  });
  return h.ctx.state
    ? saveChannels(h.ctx, COMPANY, channels).then(() => h)
    : Promise.resolve(h);
}

test("categoryFor maps events and rejects unknown", () => {
  expect(categoryFor("issue.created")).toBe("issues");
  expect(categoryFor("issue.comment.created")).toBe("issues");
  expect(categoryFor("approval.decided")).toBe("approvals");
  expect(categoryFor("agent.run.failed")).toBe("agents");
  expect(categoryFor("budget.incident.opened")).toBe("budget");
  expect(categoryFor("goal.updated")).toBe("goals");
  expect(categoryFor("project.created")).toBe("projects");
  expect(categoryFor("company.created")).toBeNull();
});

test("dispatch publishes only to channels containing the category", async () => {
  const posts: string[] = [];
  const h = await setupHarness([
    { id: "a", name: "issues", topic: "t-issues", categories: ["issues"] },
    { id: "b", name: "agents", topic: "t-agents", categories: ["agents"] },
  ]);
  const fetchStub = async (url: string, init?: RequestInit) => {
    posts.push(url);
    return new Response("{}", { status: 200 });
  };
  const result = await dispatchEvent(h.ctx, event("issue.created"), {
    fetchFn: fetchStub,
  });
  expect(posts).toEqual(["https://ntfy.example/t-issues"]);
  expect(result).toEqual({ published: 1, failed: 0 });
});

test("dispatch ignores uncategorized events", async () => {
  const posts: string[] = [];
  const h = await setupHarness([
    { id: "a", name: "all", topic: "t", categories: ["issues", "agents"] },
  ]);
  const result = await dispatchEvent(h.ctx, event("company.created"), {
    fetchFn: async (u) => (posts.push(u), new Response("ok")),
  });
  expect(posts).toEqual([]);
  expect(result).toEqual({ published: 0, failed: 0 });
});

test("a failing publish counts failure but other channels still publish", async () => {
  const posts: string[] = [];
  const h = await setupHarness([
    { id: "a", name: "a", topic: "ok", categories: ["issues"] },
    { id: "b", name: "b", topic: "fail", categories: ["issues"] },
  ]);
  const result = await dispatchEvent(h.ctx, event("issue.created"), {
    fetchFn: async (url) => {
      posts.push(url);
      return url.endsWith("/fail")
        ? new Response("no", { status: 500 })
        : new Response("ok");
    },
  });
  expect(posts).toHaveLength(2);
  expect(result).toEqual({ published: 1, failed: 1 });
});

test("formatEvent builds title/body/click for issue events", async () => {
  const h = createTestHarness({
    manifest,
    config: { appBaseUrl: "https://app.example" },
  });
  h.seed({
    companies: [
      {
        id: COMPANY,
        name: "Acme",
        description: null,
        status: "active",
        pauseReason: null,
        pausedAt: null,
        issuePrefix: "ACM",
        issueCounter: 1,
        budgetMonthlyCents: 0,
        spentMonthlyCents: 0,
        defaultResponsibleUserId: null,
        requireBoardApprovalForNewAgents: false,
        interactionResolverGovernance: "none",
        feedbackDataSharingEnabled: false,
        feedbackDataSharingConsentAt: null,
        feedbackDataSharingConsentByUserId: null,
        feedbackDataSharingTermsVersion: null,
        logoAssetId: null,
        logoUrl: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never,
    ],
    issues: [
      {
        id: "iss-1",
        companyId: COMPANY,
        identifier: "ACM-7",
        title: "Fix the thing",
      } as never,
    ],
  });
  const cfg = (await import("../src/config")).parseConfig(
    await h.ctx.config.get(COMPANY),
  );
  const fmt = await formatEvent(h.ctx, event("issue.created"), cfg);
  expect(fmt.title).toContain("ACM-7");
  expect(fmt.title).toMatch(/issue/i);
  expect(fmt.body).toContain("Fix the thing");
  expect(fmt.click).toBe("https://app.example/ACM/issues/ACM-7");
});

test("formatEvent degrades gracefully when entity fetch fails", async () => {
  const h = createTestHarness({ manifest, config: {} });
  const fmt = await formatEvent(h.ctx, event("issue.created"), {
    baseUrl: "https://ntfy.sh",
    appBaseUrl: null,
    authMode: "none",
    accessTokenSecretId: null,
    username: null,
    passwordSecretId: null,
    defaultPriority: 3,
    defaultTags: "",
  });
  expect(fmt.title).toContain("issue.created");
  expect(fmt.click).toBeUndefined();
});
