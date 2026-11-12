import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { parseConfig, buildAuthHeader } from "./config";
import { categoryFor, formatEvent } from "./events";
import { loadState } from "./state";
import { publish, type FetchLike } from "./ntfy";

export interface DispatchDeps {
  fetchFn?: FetchLike;
}

export async function dispatchEvent(
  ctx: PluginContext,
  event: PluginEvent,
  deps: DispatchDeps = {},
): Promise<{ published: number; failed: number }> {
  const category = categoryFor(event.eventType);
  if (!category) return { published: 0, failed: 0 };

  const fetchFn = deps.fetchFn ?? ((url, init) => ctx.http.fetch(url, init));

  const cfg = parseConfig(await ctx.config.get(event.companyId));
  const { channels } = await loadState(ctx, event.companyId);
  const targets = channels.filter((c) => c.categories.includes(category));
  if (targets.length === 0) return { published: 0, failed: 0 };

  let authHeader: string | null;
  try {
    authHeader = await buildAuthHeader(
      cfg,
      (ref, opts) => ctx.secrets.resolve(ref, opts),
      event.companyId,
    );
  } catch (err) {
    ctx.logger.error("ntfy auth misconfigured, skipping publish", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { published: 0, failed: 0 };
  }

  const formatted = await formatEvent(ctx, event, cfg);

  let published = 0;
  let failed = 0;
  for (const channel of targets) {
    try {
      await publish(fetchFn, {
        baseUrl: cfg.baseUrl,
        topic: channel.topic,
        authHeader,
        title: formatted.title,
        body: formatted.body,
        priority: channel.priority ?? cfg.defaultPriority,
        tags: channel.tags ?? cfg.defaultTags,
        click: formatted.click,
      });
      published += 1;
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      ctx.logger.error("ntfy publish failed", {
        channelId: channel.id,
        topic: channel.topic,
        error: message,
      });
      try {
        await ctx.activity.log({
          companyId: event.companyId,
          message: `ntfy publish to "${channel.name}" failed: ${message}`,
          entityType: event.entityType,
          entityId: event.entityId,
        });
      } catch {
        // activity logging is best-effort
      }
    }
  }
  return { published, failed };
}
