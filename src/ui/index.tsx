import { useCallback, useEffect, useMemo, useState } from "react";
import type { PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import { apiGet, apiSend } from "./api";
import "./styles.css";

const CATEGORIES = [
  "issues",
  "approvals",
  "agents",
  "budget",
  "goals",
  "projects",
] as const;

interface Channel {
  id: string;
  name: string;
  topic: string;
  categories: string[];
  priority?: number;
  tags?: string;
}

interface Subscription {
  principalId: string;
  principalType: "user" | "agent";
  channelId: string;
}

interface Member {
  principalId: string;
  principalType: "user" | "agent";
  membershipRole: string | null;
}

interface AdminState {
  channels: Channel[];
  subscriptions: Subscription[];
  members: Member[];
  config: {
    baseUrl: string;
    appBaseUrl: string | null;
    authMode: string;
  };
}

interface ServerStatus {
  health: "up" | "auth-required" | "unreachable";
  status: string;
  runtimes?: Array<{
    name: "docker" | "podman";
    compose: boolean;
    stoppedContainers: Array<{ id: string; name: string }>;
  }>;
}

function suggestedBaseUrl(): string {
  const h = window.location.hostname;
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".local")) {
    return "https://ntfy.sh";
  }
  return `https://${h}`;
}

export function NotificationsAdminPage({ context }: PluginPageProps) {
  const companyId = context.companyId;
  const [state, setState] = useState<AdminState | null>(null);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [runtime, setRuntime] = useState<"docker" | "podman">("docker");

  const [form, setForm] = useState({
    id: "",
    name: "",
    topic: "",
    categories: [] as string[],
    priority: 3,
    tags: "",
  });

  const load = useCallback(async () => {
    if (!companyId) return;
    try {
      const [s, st] = await Promise.all([
        apiGet<AdminState>("/admin/state", companyId),
        apiGet<ServerStatus>("/admin/server-status", companyId).catch(
          () => null,
        ),
      ]);
      setState(s);
      setStatus(st);
      setError(null);
    } catch (err) {
      const e = err as Error & { status?: number };
      if (e.status === 403) setForbidden(true);
      else setError(e.message);
    }
  }, [companyId]);

  useEffect(() => {
    void load();
  }, [load]);

  const runtimes = status?.runtimes ?? [];
  useEffect(() => {
    if (runtimes.length === 1 && runtimes[0]) setRuntime(runtimes[0].name);
  }, [runtimes]);

  const memberNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of state?.members ?? []) {
      map.set(
        `${m.principalType}:${m.principalId}`,
        `${m.principalType === "agent" ? "agent" : "user"} ${m.principalId.slice(0, 8)}${m.membershipRole ? ` (${m.membershipRole})` : ""}`,
      );
    }
    return map;
  }, [state]);

  async function call<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      const e = err as Error & { status?: number };
      if (e.status === 403) setForbidden(true);
      else setError(e.message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  if (forbidden) {
    return (
      <div className="ntfy-page">
        <h1>ntfy Notifications</h1>
        <div className="ntfy-card">
          <p>Only company owners and admins can manage ntfy notifications.</p>
        </div>
      </div>
    );
  }

  if (!companyId) {
    return (
      <div className="ntfy-page">
        <p className="ntfy-muted">No active company.</p>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="ntfy-page">
        <h1>ntfy Notifications</h1>
        {error ? <p className="ntfy-error">{error}</p> : <p>Loading…</p>}
      </div>
    );
  }

  const subsFor = (channelId: string) =>
    new Set(
      state.subscriptions
        .filter((s) => s.channelId === channelId)
        .map((s) => `${s.principalType}:${s.principalId}`),
    );

  async function saveChannel() {
    const body = {
      name: form.name,
      topic: form.topic,
      categories: form.categories,
      priority: form.priority,
      ...(form.tags ? { tags: form.tags } : {}),
    };
    const id = form.id || "new";
    const res = await call(() =>
      apiSend<{ channel: Channel }>(
        "PATCH",
        `/admin/channels/${id}`,
        companyId!,
        body,
      ),
    );
    if (res) {
      setForm({ id: "", name: "", topic: "", categories: [], priority: 3, tags: "" });
      await load();
    }
  }

  async function toggleMember(channelId: string, member: Member) {
    const key = `${member.principalType}:${member.principalId}`;
    const current = state!.subscriptions.filter(
      (s) => s.principalId === member.principalId && s.principalType === member.principalType,
    );
    const channelIds = new Set(current.map((s) => s.channelId));
    if (channelIds.has(channelId)) channelIds.delete(channelId);
    else channelIds.add(channelId);
    const res = await call(() =>
      apiSend("POST", "/admin/subscriptions", companyId!, {
        principalId: member.principalId,
        principalType: member.principalType,
        channelIds: [...channelIds],
      }),
    );
    if (res) await load();
  }

  return (
    <div className="ntfy-page">
      <h1>ntfy Notifications</h1>
      {error ? <p className="ntfy-error">{error}</p> : null}

      <div className="ntfy-card">
        <h2>Server</h2>
        <p className="ntfy-muted">
          Publishing to <code>{state.config.baseUrl}</code> · auth:{" "}
          {state.config.authMode}
        </p>
        {status ? (
          <p>
            Status:{" "}
            {status.health === "up" ? (
              <span className="ntfy-ok">reachable</span>
            ) : status.health === "auth-required" ? (
              <span className="ntfy-error">authentication required</span>
            ) : (
              <span className="ntfy-error">unreachable</span>
            )}
          </p>
        ) : null}
        {status?.health === "unreachable" ? (
          <>
            {runtimes.length === 0 ? (
              <p className="ntfy-muted">
                No ntfy server is reachable and no container runtime (Docker or
                Podman) was found on this host. Install ntfy manually — see{" "}
                <a href="https://docs.ntfy.sh/install/" target="_blank" rel="noreferrer">
                  docs.ntfy.sh/install
                </a>{" "}
                — then set its URL in the plugin settings.
              </p>
            ) : (
              <>
                <p className="ntfy-muted">
                  No ntfy server is reachable at{" "}
                  <code>{state.config.baseUrl}</code>.{" "}
                  {runtimes.length > 1 ? "Choose a runtime:" : null}
                </p>
                <div className="ntfy-row">
                  {runtimes.length > 1
                    ? runtimes.map((r) => (
                        <label key={r.name}>
                          <input
                            type="radio"
                            name="runtime"
                            checked={runtime === r.name}
                            onChange={() => setRuntime(r.name)}
                          />
                          {r.name}
                        </label>
                      ))
                    : null}
                </div>
                {runtimes
                  .filter((r) => r.name === runtime || runtimes.length === 1)
                  .flatMap((r) =>
                    r.stoppedContainers.map((c) => (
                      <div className="ntfy-row" key={c.id}>
                        <span className="ntfy-muted">
                          Stopped ntfy container found ({r.name}): {c.name}
                        </span>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void call(async () => {
                              await apiSend("POST", "/admin/server-setup", companyId!, {
                                op: "start-container",
                                runtime: r.name,
                                containerId: c.id,
                              });
                              await load();
                            })
                          }
                        >
                          Start it
                        </button>
                      </div>
                    )),
                  )}
                {runtimes.find((r) => r.name === runtime)?.compose ? (
                  <div className="ntfy-row">
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() =>
                        void call(async () => {
                          const res = await apiSend<{
                            suggestedBaseUrl?: string;
                          }>("POST", "/admin/server-setup", companyId!, {
                            op: "compose-up",
                            runtime,
                          });
                          await load();
                          if (res?.suggestedBaseUrl) {
                            setError(
                              `ntfy started. Set baseUrl to ${res.suggestedBaseUrl} in plugin settings.`,
                            );
                          }
                        })
                      }
                    >
                      Install ntfy with {runtime} compose
                    </button>
                    <span className="ntfy-muted">
                      Creates a default container (port 2580) via a generated
                      compose file.
                    </span>
                  </div>
                ) : null}
              </>
            )}
            <p className="ntfy-muted">
              Suggested baseUrl for this host: <code>{suggestedBaseUrl()}</code>
              {state.config.appBaseUrl ? null : (
                <> · appBaseUrl <code>{window.location.origin}</code></>
              )}
              — set these in the plugin's settings.
            </p>
          </>
        ) : null}
      </div>

      <div className="ntfy-card">
        <h2>Channels</h2>
        {state.channels.map((ch) => (
          <div key={ch.id} className="ntfy-card">
            <div className="ntfy-row">
              <strong>{ch.name}</strong>
              <code>{ch.topic}</code>
              <span className="ntfy-muted">{ch.categories.join(", ")}</span>
              <button
                disabled={busy}
                onClick={() =>
                  void call(async () => {
                    await apiSend("POST", "/admin/test", companyId!, {
                      channelId: ch.id,
                    });
                  })
                }
              >
                Send test
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  setForm({
                    id: ch.id,
                    name: ch.name,
                    topic: ch.topic,
                    categories: ch.categories,
                    priority: ch.priority ?? 3,
                    tags: ch.tags ?? "",
                  })
                }
              >
                Edit
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  void call(async () => {
                    await apiSend("DELETE", `/admin/channels/${ch.id}`, companyId!);
                    await load();
                  })
                }
              >
                Delete
              </button>
            </div>
            <div className="ntfy-members">
              {(state.members ?? []).map((m) => {
                const key = `${m.principalType}:${m.principalId}`;
                return (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={subsFor(ch.id).has(key)}
                      disabled={busy}
                      onChange={() => void toggleMember(ch.id, m)}
                    />
                    {memberNames.get(key) ?? key}
                  </label>
                );
              })}
            </div>
          </div>
        ))}

        <h2>{form.id ? "Edit channel" : "New channel"}</h2>
        <div className="ntfy-row">
          <input
            type="text"
            placeholder="Name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <input
            type="text"
            placeholder="ntfy topic"
            value={form.topic}
            onChange={(e) => setForm({ ...form, topic: e.target.value })}
          />
          <label>
            Priority
            <input
              type="number"
              min={1}
              max={5}
              value={form.priority}
              onChange={(e) =>
                setForm({ ...form, priority: Number(e.target.value) })
              }
              style={{ minWidth: 0, width: 56 }}
            />
          </label>
          <input
            type="text"
            placeholder="tags (optional)"
            value={form.tags}
            onChange={(e) => setForm({ ...form, tags: e.target.value })}
          />
        </div>
        <div className="ntfy-cats">
          {CATEGORIES.map((c) => (
            <label key={c}>
              <input
                type="checkbox"
                checked={form.categories.includes(c)}
                onChange={(e) =>
                  setForm({
                    ...form,
                    categories: e.target.checked
                      ? [...form.categories, c]
                      : form.categories.filter((x) => x !== c),
                  })
                }
              />
              {c}
            </label>
          ))}
        </div>
        <div className="ntfy-row">
          <button
            className="primary"
            disabled={
              busy || !form.name.trim() || !form.topic.trim() || form.categories.length === 0
            }
            onClick={() => void saveChannel()}
          >
            {form.id ? "Save channel" : "Create channel"}
          </button>
          {form.id ? (
            <button
              disabled={busy}
              onClick={() =>
                setForm({ id: "", name: "", topic: "", categories: [], priority: 3, tags: "" })
              }
            >
              Cancel
            </button>
          ) : null}
        </div>
        <p className="ntfy-muted">
          A topic carries exactly the categories selected on its channel.
          Members you check receive that channel — share each topic name only
          with its checked members so they can subscribe in their own ntfy app.
        </p>
      </div>
    </div>
  );
}
