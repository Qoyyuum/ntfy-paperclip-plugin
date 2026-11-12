import type { PluginContext } from "@paperclipai/plugin-sdk";

export interface NtfyChannel {
  id: string;
  name: string;
  topic: string;
  categories: string[];
  priority?: number;
  tags?: string;
}

export interface NtfySubscription {
  principalId: string;
  principalType: "user" | "agent";
  channelId: string;
}

export interface NtfyCompanyState {
  channels: NtfyChannel[];
  subscriptions: NtfySubscription[];
}

const CHANNELS_KEY = "channels";
const SUBSCRIPTIONS_KEY = "subscriptions";

function scope(companyId: string, stateKey: string) {
  return { scopeKind: "company" as const, scopeId: companyId, stateKey };
}

function isChannel(v: unknown): v is NtfyChannel {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    typeof c.name === "string" &&
    typeof c.topic === "string" &&
    Array.isArray(c.categories)
  );
}

function isSubscription(v: unknown): v is NtfySubscription {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.principalId === "string" &&
    (s.principalType === "user" || s.principalType === "agent") &&
    typeof s.channelId === "string"
  );
}

async function readList<T>(
  ctx: PluginContext,
  companyId: string,
  key: string,
  guard: (v: unknown) => v is T,
): Promise<T[]> {
  const raw = await ctx.state.get(scope(companyId, key));
  if (!Array.isArray(raw)) return [];
  return raw.filter(guard);
}

export async function loadState(
  ctx: PluginContext,
  companyId: string,
): Promise<NtfyCompanyState> {
  const [channels, subscriptions] = await Promise.all([
    readList(ctx, companyId, CHANNELS_KEY, isChannel),
    readList(ctx, companyId, SUBSCRIPTIONS_KEY, isSubscription),
  ]);
  return { channels, subscriptions };
}

export async function saveChannels(
  ctx: PluginContext,
  companyId: string,
  channels: NtfyChannel[],
): Promise<void> {
  await ctx.state.set(scope(companyId, CHANNELS_KEY), channels);
}

export async function saveSubscriptions(
  ctx: PluginContext,
  companyId: string,
  subscriptions: NtfySubscription[],
): Promise<void> {
  await ctx.state.set(scope(companyId, SUBSCRIPTIONS_KEY), subscriptions);
}
