export interface NtfyPluginConfig {
  baseUrl: string;
  appBaseUrl: string | null;
  authMode: "none" | "token" | "basic";
  accessTokenSecretId: string | null;
  username: string | null;
  passwordSecretId: string | null;
  defaultPriority: number;
  defaultTags: string;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function stripSlash(url: string | null): string | null {
  return url ? url.replace(/\/+$/, "") : null;
}

export function parseConfig(raw: Record<string, unknown>): NtfyPluginConfig {
  const priority = typeof raw.defaultPriority === "number" ? raw.defaultPriority : 3;
  const authMode = raw.authMode === "token" || raw.authMode === "basic" ? raw.authMode : "none";
  return {
    baseUrl: stripSlash(str(raw.baseUrl)) ?? "https://ntfy.sh",
    appBaseUrl: stripSlash(str(raw.appBaseUrl)),
    authMode,
    accessTokenSecretId: str(raw.accessTokenSecretId),
    username: str(raw.username),
    passwordSecretId: str(raw.passwordSecretId),
    defaultPriority: Math.min(5, Math.max(1, Math.round(priority))),
    defaultTags: str(raw.defaultTags) ?? "",
  };
}

export type SecretResolver = (
  ref: { type: "secret_ref"; secretId: string },
  opts?: { companyId?: string; configPath?: string },
) => Promise<string>;

export async function buildAuthHeader(
  cfg: NtfyPluginConfig,
  resolveSecret: SecretResolver,
  companyId: string,
): Promise<string | null> {
  if (cfg.authMode === "none") return null;
  if (cfg.authMode === "token") {
    if (!cfg.accessTokenSecretId) {
      throw new Error("authMode is 'token' but accessTokenSecretId is not set");
    }
    const token = await resolveSecret(
      { type: "secret_ref", secretId: cfg.accessTokenSecretId },
      { companyId, configPath: "accessTokenSecretId" },
    );
    return `Bearer ${token}`;
  }
  if (!cfg.username || !cfg.passwordSecretId) {
    throw new Error(
      "authMode is 'basic' but username or passwordSecretId is not set",
    );
  }
  const password = await resolveSecret(
    { type: "secret_ref", secretId: cfg.passwordSecretId },
    { companyId, configPath: "passwordSecretId" },
  );
  return `Basic ${Buffer.from(`${cfg.username}:${password}`).toString("base64")}`;
}
