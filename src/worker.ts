import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEventType,
} from "@paperclipai/plugin-sdk";
import { dispatchEvent } from "./dispatch";
import { EVENT_CATEGORY_MAP } from "./events";
import { handleApiRequest } from "./routes";

let lastPublish: { at: string; published: number; failed: number } | null = null;
let workerCtx: PluginContext | null = null;

const plugin = definePlugin({
  multiCompanyConfig: true,

  async setup(ctx) {
    workerCtx = ctx;
    for (const eventType of Object.keys(EVENT_CATEGORY_MAP)) {
      ctx.events.on(eventType as PluginEventType, async (event) => {
        try {
          const result = await dispatchEvent(ctx, event);
          lastPublish = { at: new Date().toISOString(), ...result };
        } catch (err) {
          ctx.logger.error("ntfy dispatch failed", {
            eventType: event.eventType,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    }
    ctx.logger.info("ntfy plugin started", {
      events: Object.keys(EVENT_CATEGORY_MAP).length,
    });
  },

  async onHealth() {
    return {
      status: "ok",
      details: {
        lastPublish,
        started: workerCtx != null,
      },
    };
  },

  async onValidateConfig(config) {
    const errors: string[] = [];
    const warnings: string[] = [];

    const baseUrl = typeof config.baseUrl === "string" ? config.baseUrl : "";
    if (baseUrl) {
      try {
        new URL(baseUrl);
      } catch {
        errors.push("baseUrl is not a valid URL");
      }
    }

    if (config.authMode === "token" && !config.accessTokenSecretId) {
      errors.push("authMode 'token' requires accessTokenSecretId");
    }
    if (config.authMode === "basic") {
      if (!config.username) errors.push("authMode 'basic' requires username");
      if (!config.passwordSecretId) {
        errors.push("authMode 'basic' requires passwordSecretId");
      }
    }
    if (!config.appBaseUrl) {
      warnings.push("appBaseUrl is not set — notifications will not include Click links");
    }

    return errors.length ? { ok: false, errors, warnings } : { ok: true, warnings };
  },

  async onApiRequest(input) {
    if (!workerCtx) return { status: 503, body: { error: "worker not ready" } };
    return handleApiRequest(workerCtx, input);
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
