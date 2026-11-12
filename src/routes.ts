import type {
  PluginApiRequestInput,
  PluginApiResponse,
  PluginContext,
} from "@paperclipai/plugin-sdk";
import { AdminRequiredError, requireAdmin } from "./admin";
import { buildAuthHeader, parseConfig } from "./config";
import { EVENT_CATEGORIES } from "./events";
import { publish, type FetchLike } from "./ntfy";
import {
  getServerStatus,
  runSetup,
  type ExecFn,
  type ServerSetupBody,
} from "./server-setup";
import { loadState, saveChannels, saveSubscriptions } from "./state";

export interface RouteDeps {
  fetchFn?: FetchLike;
  exec?: ExecFn;
}

function json(status: number, body: unknown): PluginApiResponse {
  return { status, body };
}

async function resolveAuth(ctx: PluginContext, companyId: string) {
  const cfg = parseConfig(await ctx.config.get(companyId));
  const authHeader = await buildAuthHeader(
    cfg,
    (ref, opts) => ctx.secrets.resolve(ref, opts),
    companyId,
  );
  return { cfg, authHeader };
}

function configError(err: unknown): PluginApiResponse {
  return json(500, {
    error: err instanceof Error ? err.message : String(err),
  });
}

export async function handleApiRequest(
  ctx: PluginContext,
  input: PluginApiRequestInput,
  deps: RouteDeps = {},
): Promise<PluginApiResponse> {
  try {
    await requireAdmin(ctx, input.companyId, input.actor.userId);
  } catch (err) {
    if (err instanceof AdminRequiredError) {
      return json(403, { error: "admin_required" });
    }
    throw err;
  }

  const fetchFn = deps.fetchFn ?? ((url, init) => ctx.http.fetch(url, init));
  const body = (input.body ?? {}) as Record<string, unknown>;

  switch (input.routeKey) {
    case "admin-state": {
      const [state, members] = await Promise.all([
        loadState(ctx, input.companyId),
        ctx.access.members.list({ companyId: input.companyId }),
      ]);
      const cfg = parseConfig(await ctx.config.get(input.companyId));
      return json(200, {
        channels: state.channels,
        subscriptions: state.subscriptions,
        members: members
          .filter((m) => m.status === "active")
          .map((m) => ({
            principalId: m.principalId,
            principalType: m.principalType,
            membershipRole: m.membershipRole,
          })),
        config: {
          baseUrl: cfg.baseUrl,
          appBaseUrl: cfg.appBaseUrl,
          authMode: cfg.authMode,
          hasAccessToken: cfg.accessTokenSecretId != null,
          username: cfg.username,
          hasPassword: cfg.passwordSecretId != null,
          defaultPriority: cfg.defaultPriority,
          defaultTags: cfg.defaultTags,
        },
      });
    }

    case "channel-upsert": {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const topic = typeof body.topic === "string" ? body.topic.trim() : "";
      const categories = Array.isArray(body.categories) ? body.categories : null;
      if (!name || !topic || !categories?.length) {
        return json(400, { error: "name, topic, and categories are required" });
      }
      const invalid = categories.filter(
        (c) => !EVENT_CATEGORIES.includes(c as (typeof EVENT_CATEGORIES)[number]),
      );
      if (invalid.length) {
        return json(400, { error: `unknown categories: ${invalid.join(", ")}` });
      }
      if (
        body.priority != null &&
        (!Number.isInteger(body.priority) ||
          (body.priority as number) < 1 ||
          (body.priority as number) > 5)
      ) {
        return json(400, { error: "priority must be an integer 1-5" });
      }
      const state = await loadState(ctx, input.companyId);
      const id =
        input.params.id && input.params.id !== "new"
          ? input.params.id
          : crypto.randomUUID();
      const channel = {
        id,
        name,
        topic,
        categories: categories as string[],
        ...(typeof body.priority === "number" ? { priority: body.priority } : {}),
        ...(typeof body.tags === "string" && body.tags ? { tags: body.tags } : {}),
      };
      const idx = state.channels.findIndex((c) => c.id === id);
      if (idx >= 0) state.channels[idx] = channel;
      else state.channels.push(channel);
      await saveChannels(ctx, input.companyId, state.channels);
      return json(200, { channel });
    }

    case "channel-delete": {
      const id = input.params.id;
      if (!id) return json(400, { error: "channel id required" });
      const state = await loadState(ctx, input.companyId);
      state.channels = state.channels.filter((c) => c.id !== id);
      state.subscriptions = state.subscriptions.filter((s) => s.channelId !== id);
      await saveChannels(ctx, input.companyId, state.channels);
      await saveSubscriptions(ctx, input.companyId, state.subscriptions);
      return json(200, { ok: true });
    }

    case "subscriptions-set": {
      const principalId = body.principalId;
      const principalType = body.principalType;
      const channelIds = Array.isArray(body.channelIds) ? body.channelIds : null;
      if (
        typeof principalId !== "string" ||
        (principalType !== "user" && principalType !== "agent") ||
        !channelIds
      ) {
        return json(400, {
          error: "principalId, principalType, and channelIds are required",
        });
      }
      const [state, members] = await Promise.all([
        loadState(ctx, input.companyId),
        ctx.access.members.list({ companyId: input.companyId }),
      ]);
      const isMember = members.some(
        (m) =>
          m.status === "active" &&
          m.principalId === principalId &&
          m.principalType === principalType,
      );
      if (!isMember) {
        return json(400, { error: "principal is not an active company member" });
      }
      const known = new Set(state.channels.map((c) => c.id));
      const uniqueChannelIds = [...new Set(channelIds as string[])];
      const unknown = uniqueChannelIds.filter((id) => !known.has(id));
      if (unknown.length) {
        return json(400, { error: `unknown channels: ${unknown.join(", ")}` });
      }
      const kept = state.subscriptions.filter(
        (s) =>
          !(s.principalId === principalId && s.principalType === principalType),
      );
      for (const channelId of uniqueChannelIds) {
        kept.push({ principalId, principalType, channelId });
      }
      await saveSubscriptions(ctx, input.companyId, kept);
      return json(200, { ok: true });
    }

    case "test-send": {
      const channelId = body.channelId;
      if (typeof channelId !== "string") {
        return json(400, { error: "channelId required" });
      }
      const state = await loadState(ctx, input.companyId);
      const channel = state.channels.find((c) => c.id === channelId);
      if (!channel) return json(404, { error: "channel not found" });
      let resolved: Awaited<ReturnType<typeof resolveAuth>>;
      try {
        resolved = await resolveAuth(ctx, input.companyId);
      } catch (err) {
        return configError(err);
      }
      const { cfg, authHeader } = resolved;
      try {
        await publish(fetchFn, {
          baseUrl: cfg.baseUrl,
          topic: channel.topic,
          authHeader,
          title: "Paperclip ntfy test",
          body: "Test notification from the Paperclip ntfy plugin.",
          priority: channel.priority ?? cfg.defaultPriority,
          tags: channel.tags ?? cfg.defaultTags,
        });
      } catch (err) {
        return json(502, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return json(200, { ok: true });
    }

    case "server-status": {
      let resolved: Awaited<ReturnType<typeof resolveAuth>>;
      try {
        resolved = await resolveAuth(ctx, input.companyId);
      } catch (err) {
        return json(200, {
          health: "error",
          status: "config-error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return getServerStatus(resolved.cfg, resolved.authHeader, {
        fetchFn,
        ...(deps.exec ? { exec: deps.exec } : {}),
      });
    }

    case "server-setup": {
      let resolved: Awaited<ReturnType<typeof resolveAuth>>;
      try {
        resolved = await resolveAuth(ctx, input.companyId);
      } catch (err) {
        return configError(err);
      }
      const { cfg, authHeader } = resolved;
      return runSetup(body as unknown as ServerSetupBody, {
        fetchFn,
        ...(deps.exec ? { exec: deps.exec } : {}),
        checkHealth: async () => {
          const { healthCheck } = await import("./ntfy");
          return healthCheck(fetchFn, cfg.baseUrl, authHeader);
        },
      });
    }

    default:
      return json(404, { error: `unknown route: ${input.routeKey}` });
  }
}
