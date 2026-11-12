import { test, expect } from "bun:test";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { manifest } from "../src/manifest";
import { requireAdmin, AdminRequiredError } from "../src/admin";
import type { PluginAccessMember } from "@paperclipai/plugin-sdk";

const COMPANY = "company-1";

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

function harnessWith(members: PluginAccessMember[]) {
  const h = createTestHarness({ manifest });
  h.seed({ accessMembers: members });
  return h;
}

test("owner passes", async () => {
  const h = harnessWith([member({ principalId: "u1", membershipRole: "owner" })]);
  const m = await requireAdmin(h.ctx, COMPANY, "u1");
  expect(m.principalId).toBe("u1");
});

test("admin role passes, viewer/member roles rejected", async () => {
  const h = harnessWith([
    member({ principalId: "adm", membershipRole: "admin" }),
    member({ principalId: "vw", membershipRole: "viewer" }),
    member({ principalId: "mb", membershipRole: "member" }),
  ]);
  await expect(requireAdmin(h.ctx, COMPANY, "adm")).resolves.toBeTruthy();
  await expect(requireAdmin(h.ctx, COMPANY, "vw")).rejects.toThrow(AdminRequiredError);
  await expect(requireAdmin(h.ctx, COMPANY, "mb")).rejects.toThrow(AdminRequiredError);
});

test("null userId and agent principals rejected", async () => {
  const h = harnessWith([
    member({ principalId: "ag1", principalType: "agent", membershipRole: "owner" }),
  ]);
  await expect(requireAdmin(h.ctx, COMPANY, null)).rejects.toThrow(AdminRequiredError);
  await expect(requireAdmin(h.ctx, COMPANY, "ag1")).rejects.toThrow(AdminRequiredError);
});

test("suspended admin rejected", async () => {
  const h = harnessWith([
    member({ principalId: "u2", membershipRole: "owner", status: "suspended" }),
  ]);
  await expect(requireAdmin(h.ctx, COMPANY, "u2")).rejects.toThrow(AdminRequiredError);
});
