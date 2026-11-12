import type { PluginAccessMember, PluginContext } from "@paperclipai/plugin-sdk";

export class AdminRequiredError extends Error {
  constructor() {
    super("admin_required");
    this.name = "AdminRequiredError";
  }
}

export async function requireAdmin(
  ctx: PluginContext,
  companyId: string,
  userId: string | null | undefined,
): Promise<PluginAccessMember> {
  if (!userId) throw new AdminRequiredError();
  const members = await ctx.access.members.list({ companyId });
  const match = members.find(
    (m) =>
      m.principalType === "user" &&
      m.principalId === userId &&
      m.status === "active" &&
      (m.membershipRole === "owner" || m.membershipRole === "admin"),
  );
  if (!match) throw new AdminRequiredError();
  return match;
}
