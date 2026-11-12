import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import type { NtfyPluginConfig } from "./config";

export const EVENT_CATEGORIES = [
  "issues",
  "approvals",
  "agents",
  "budget",
  "goals",
  "projects",
] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export const EVENT_CATEGORY_MAP: Record<string, EventCategory> = {
  "issue.created": "issues",
  "issue.updated": "issues",
  "issue.comment.created": "issues",
  "approval.created": "approvals",
  "approval.decided": "approvals",
  "agent.run.started": "agents",
  "agent.run.finished": "agents",
  "agent.run.failed": "agents",
  "agent.status_changed": "agents",
  "budget.incident.opened": "budget",
  "budget.incident.resolved": "budget",
  "goal.created": "goals",
  "goal.updated": "goals",
  "project.created": "projects",
  "project.updated": "projects",
};

export function categoryFor(eventType: string): EventCategory | null {
  return EVENT_CATEGORY_MAP[eventType] ?? null;
}

export interface FormattedNotification {
  title: string;
  body: string;
  click?: string;
}

export async function formatEvent(
  ctx: PluginContext,
  event: PluginEvent,
  cfg: NtfyPluginConfig,
): Promise<FormattedNotification> {
  const fallback: FormattedNotification = {
    title: `Paperclip: ${event.eventType}`,
    body: `Event ${event.eventType} on ${event.entityType ?? "entity"} ${event.entityId ?? ""}`.trim(),
  };
  try {
    switch (event.entityType) {
      case "issue": {
        const [issue, company] = await Promise.all([
          ctx.issues.get(event.entityId!, event.companyId),
          ctx.companies.get(event.companyId),
        ]);
        if (!issue) return fallback;
        const ref = issue.identifier ?? issue.id;
        const verb =
          event.eventType === "issue.comment.created"
            ? "New comment on"
            : event.eventType === "issue.created"
              ? "New issue"
              : "Updated issue";
        const out: FormattedNotification = {
          title: `${verb} ${ref}`,
          body: `${issue.title}`,
        };
        if (cfg.appBaseUrl && issue.identifier) {
          const prefix = company?.issuePrefix ?? issue.identifier.split("-")[0];
          out.click = `${cfg.appBaseUrl}/${prefix}/issues/${issue.identifier}`;
        }
        return out;
      }
      case "run":
      case "agent": {
        const agentId =
          (event.payload as Record<string, unknown> | null)?.agentId as
            | string
            | undefined ?? (event.entityType === "agent" ? event.entityId : undefined);
        const agent = agentId ? await ctx.agents.get(agentId, event.companyId) : null;
        const label = agent?.name ?? agentId ?? "agent";
        return {
          title: `Paperclip: ${event.eventType}`,
          body: `Agent ${label}: ${event.eventType}`,
        };
      }
      case "approval": {
        const approval = event.entityId
          ? await ctx.approvals.get(event.entityId, event.companyId)
          : null;
        return {
          title: `Paperclip: ${event.eventType}`,
          body: approval
            ? `Approval ${approval.type} — ${approval.status}`
            : fallback.body,
        };
      }
      case "goal": {
        const goal = event.entityId
          ? await ctx.goals.get(event.entityId, event.companyId)
          : null;
        return {
          title: `Paperclip: ${event.eventType}`,
          body: goal ? `Goal: ${goal.title}` : fallback.body,
        };
      }
      case "project": {
        const project = event.entityId
          ? await ctx.projects.get(event.entityId, event.companyId)
          : null;
        return {
          title: `Paperclip: ${event.eventType}`,
          body: project ? `Project: ${project.name}` : fallback.body,
        };
      }
      default:
        return fallback;
    }
  } catch {
    return fallback;
  }
}
