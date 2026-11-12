export type FetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export interface NtfyPublishInput {
  baseUrl: string;
  topic: string;
  authHeader: string | null;
  title: string;
  body: string;
  priority?: number;
  tags?: string;
  click?: string;
}

function topicUrl(baseUrl: string, topic: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/${encodeURIComponent(topic)}`;
}

export async function publish(
  fetchFn: FetchLike,
  input: NtfyPublishInput,
): Promise<void> {
  const headers: Record<string, string> = { Title: input.title };
  if (input.authHeader) headers.Authorization = input.authHeader;
  if (input.priority != null) headers.Priority = String(input.priority);
  if (input.tags) headers.Tags = input.tags;
  if (input.click) headers.Click = input.click;

  const res = await fetchFn(topicUrl(input.baseUrl, input.topic), {
    method: "POST",
    headers,
    body: input.body,
  });
  if (!res.ok) {
    throw new Error(`ntfy publish failed: HTTP ${res.status}`);
  }
}

export type NtfyHealth = "up" | "auth-required" | "unreachable";

export async function healthCheck(
  fetchFn: FetchLike,
  baseUrl: string,
  authHeader: string | null,
  timeoutMs = 5000,
): Promise<NtfyHealth> {
  const headers: Record<string, string> = {};
  if (authHeader) headers.Authorization = authHeader;
  try {
    const res = await fetchFn(
      `${baseUrl.replace(/\/+$/, "")}/v1/health`,
      { headers, signal: AbortSignal.timeout(timeoutMs) },
    );
    if (res.status === 401 || res.status === 403) return "auth-required";
    return res.ok ? "up" : "unreachable";
  } catch {
    return "unreachable";
  }
}
