let cachedBase: string | null = null;

export async function resolveApiBase(): Promise<string> {
  if (cachedBase) return cachedBase;
  const key = "paperclip.ntfy";
  try {
    const res = await fetch("/api/plugins");
    if (res.ok) {
      const data = (await res.json()) as Record<string, unknown>;
      const list = Array.isArray(data)
        ? data
        : ((data.plugins ?? data.items ?? []) as Array<Record<string, unknown>>);
      const match = list.find(
        (p: { pluginKey?: string; manifestJson?: { id?: string }; id?: string }) =>
          p.pluginKey === key || p.manifestJson?.id === key,
      );
      if (match?.id) {
        cachedBase = `/api/plugins/${match.id}/api`;
        return cachedBase;
      }
    }
  } catch {
    // fall through to key-based base
  }
  cachedBase = `/api/plugins/${key}/api`;
  return cachedBase;
}

async function request<T>(
  method: string,
  path: string,
  opts: { companyId: string; body?: Record<string, unknown> },
): Promise<T> {
  const base = await resolveApiBase();
  const url = new URL(`${base}${path}`, window.location.origin);
  url.searchParams.set("companyId", opts.companyId);
  const res = await fetch(url.toString(), {
    method,
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
    body: opts.body
      ? JSON.stringify({ companyId: opts.companyId, ...opts.body })
      : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      (data as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
    const err = new Error(msg) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return data as T;
}

export const apiGet = <T>(path: string, companyId: string) =>
  request<T>("GET", path, { companyId });
export const apiSend = <T>(
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  companyId: string,
  body: Record<string, unknown> = {},
) => request<T>(method, path, { companyId, body });
