import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PluginApiResponse } from "@paperclipai/plugin-sdk";
import type { NtfyPluginConfig } from "./config";
import { healthCheck, type FetchLike, type NtfyHealth } from "./ntfy";

export type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile);

export const defaultExec: ExecFn = async (cmd, args, opts) => {
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    timeout: opts?.timeoutMs ?? 15_000,
    maxBuffer: 1024 * 1024,
  });
  return { stdout: stdout.toString(), stderr: stderr.toString() };
};

export interface RuntimeInfo {
  name: "docker" | "podman";
  compose: boolean;
  stoppedContainers: Array<{ id: string; name: string }>;
}

export interface RuntimeProbe {
  runtimes: RuntimeInfo[];
}

const RUNTIMES = ["docker", "podman"] as const;

async function tryExec(
  exec: ExecFn,
  cmd: string,
  args: string[],
): Promise<string | null> {
  try {
    const { stdout } = await exec(cmd, args, { timeoutMs: 10_000 });
    return stdout;
  } catch {
    return null;
  }
}

export async function probeRuntimes(exec: ExecFn): Promise<RuntimeProbe> {
  const runtimes: RuntimeInfo[] = [];
  for (const name of RUNTIMES) {
    const found = await tryExec(exec, "sh", ["-c", `command -v ${name}`]);
    if (found === null) continue;

    let compose = false;
    if ((await tryExec(exec, name, ["compose", "version"])) !== null) {
      compose = true;
    } else if (
      (await tryExec(exec, `${name}-compose`, ["version"])) !== null
    ) {
      compose = true;
    }

    const stoppedContainers: Array<{ id: string; name: string }> = [];
    const ps = await tryExec(exec, name, [
      "ps",
      "-a",
      "--format",
      "{{.ID}} {{.Names}}",
      "--filter",
      "name=ntfy",
    ]);
    for (const line of (ps ?? "").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [id, ...rest] = trimmed.split(/\s+/);
      if (!id) continue;
      const state = await tryExec(exec, name, [
        "inspect",
        "-f",
        "{{.State.Status}}",
        id,
      ]);
      const status = state?.trim();
      if (status && status !== "running") {
        stoppedContainers.push({ id, name: rest.join(" ") || id });
      }
    }
    runtimes.push({ name, compose, stoppedContainers });
  }
  return { runtimes };
}

export function composeFileYaml(port: number): string {
  return `services:
  ntfy:
    image: docker.io/binwiederhier/ntfy:latest
    container_name: ntfy
    command: serve
    restart: unless-stopped
    ports:
      - "${port}:80"
    environment:
      NTFY_BASE_URL: ""
      NTFY_CACHE_FILE: /var/cache/ntfy/cache.db
      NTFY_BEHIND_PROXY: "false"
      NTFY_ATTACHMENT_CACHE_DIR: /var/cache/ntfy/attachments
    volumes:
      - ntfy-cache:/var/cache/ntfy
volumes:
  ntfy-cache:
`;
}

export interface SetupDeps {
  exec?: ExecFn;
  dataDir?: string;
  checkHealth?: () => Promise<NtfyHealth>;
  fetchFn?: FetchLike;
}

export interface ServerSetupBody {
  op: "start-container" | "compose-up";
  runtime: "docker" | "podman";
  containerId?: string;
  port?: number;
}

function err(status: number, message: string): PluginApiResponse {
  return { status, body: { error: message } };
}

export async function runSetup(
  body: ServerSetupBody,
  deps: SetupDeps = {},
): Promise<PluginApiResponse> {
  const exec = deps.exec ?? defaultExec;
  const health = deps.checkHealth ?? (async () => "unreachable" as NtfyHealth);

  if (body.runtime !== "docker" && body.runtime !== "podman") {
    return err(400, "runtime must be 'docker' or 'podman'");
  }

  if (body.op === "start-container") {
    if (
      typeof body.containerId !== "string" ||
      !/^[a-zA-Z0-9_.-]+$/.test(body.containerId)
    ) {
      return err(400, "a valid containerId is required");
    }
    const probe = await probeRuntimes(exec);
    const runtime = probe.runtimes.find((r) => r.name === body.runtime);
    if (!runtime) return err(400, `${body.runtime} is not available`);
    if (!runtime.stoppedContainers.some((c) => c.id === body.containerId)) {
      return err(400, "containerId is not a stopped ntfy container");
    }
    const out = await tryExec(exec, body.runtime, ["start", body.containerId]);
    if (out === null) return err(500, `${body.runtime} start failed`);
    return { status: 200, body: { ok: true, health: await health() } };
  }

  if (body.op === "compose-up") {
    const port = body.port ?? 2580;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return err(400, "port must be an integer between 1 and 65535");
    }
    const dir = deps.dataDir ?? join(homedir(), ".local", "share", "ntfy-paperclip-plugin");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "docker-compose.yml");
    writeFileSync(file, composeFileYaml(port));

    let up = await tryExec(exec, body.runtime, [
      "compose",
      "-f",
      file,
      "up",
      "-d",
    ]);
    if (up === null) {
      up = await tryExec(exec, `${body.runtime}-compose`, [
        "-f",
        file,
        "up",
        "-d",
      ]);
    }
    if (up === null) return err(500, "compose up failed");
    return {
      status: 200,
      body: {
        ok: true,
        health: await health(),
        suggestedBaseUrl: `http://localhost:${port}`,
        composeFile: file,
        warning:
          "The generated config exposes ntfy on all interfaces with no authentication. Set authMode to 'token' or 'basic' and configure ntfy access control before exposing port " +
          port +
          " beyond localhost.",
      },
    };
  }

  return err(400, "op must be 'start-container' or 'compose-up'");
}

export async function getServerStatus(
  cfg: NtfyPluginConfig,
  authHeader: string | null,
  deps: { fetchFn: FetchLike; exec?: ExecFn } = { fetchFn: fetch },
): Promise<PluginApiResponse> {
  const health = await healthCheck(deps.fetchFn, cfg.baseUrl, authHeader);
  if (health !== "unreachable") {
    return { status: 200, body: { health, status: health } };
  }
  const probe = await probeRuntimes(deps.exec ?? defaultExec);
  return {
    status: 200,
    body: {
      health,
      status:
        probe.runtimes.length > 0
          ? "unreachable-with-runtime"
          : "unreachable-no-runtime",
      runtimes: probe.runtimes,
    },
  };
}
