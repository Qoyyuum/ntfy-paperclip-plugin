import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  probeRuntimes,
  composeFileYaml,
  runSetup,
  type ExecFn,
} from "../src/server-setup";

type FakeExec = { calls: string[]; fn: ExecFn };

function fakeExec(map: Record<string, string | Error>): FakeExec {
  const calls: string[] = [];
  const fn: ExecFn = async (cmd, args) => {
    const key = [cmd, ...args].join(" ");
    calls.push(key);
    for (const [k, v] of Object.entries(map)) {
      if (key.includes(k)) {
        if (v instanceof Error) throw v;
        return { stdout: v, stderr: "" };
      }
    }
    throw new Error("command not found: " + key);
  };
  return { calls, fn };
}

test("probeRuntimes reports podman when docker absent", async () => {
  const { fn } = fakeExec({
    "command -v podman": "/usr/bin/podman",
    "podman compose version": "1.0.0",
    "podman ps -a": "",
  });
  const probe = await probeRuntimes(fn);
  expect(probe.runtimes).toHaveLength(1);
  expect(probe.runtimes[0]!.name).toBe("podman");
  expect(probe.runtimes[0]!.compose).toBe(true);
});

test("probeRuntimes lists stopped ntfy containers and compose availability", async () => {
  const { fn } = fakeExec({
    "command -v docker": "/usr/bin/docker",
    "docker compose version": "2.20",
    "docker ps -a --format": "abc123 ntfy\n",
    "docker inspect": "exited",
  });
  const probe = await probeRuntimes(fn);
  expect(probe.runtimes[0]!.stoppedContainers).toEqual([
    { id: "abc123", name: "ntfy" },
  ]);
});

test("probeRuntimes never throws when everything is missing", async () => {
  const { fn } = fakeExec({});
  const probe = await probeRuntimes(fn);
  expect(probe.runtimes).toEqual([]);
});

test("runSetup start-container starts and re-probes", async () => {
  const { calls, fn } = fakeExec({ "docker start": "" });
  const res = await runSetup(
    { op: "start-container", runtime: "docker", containerId: "abc123" },
    { exec: fn, checkHealth: async () => "up" },
  );
  expect(calls.some((c) => c.includes("docker start abc123"))).toBe(true);
  const body = res.body as Record<string, unknown>;
  expect(body.health).toBe("up");
});

test("runSetup compose-up writes compose file and runs compose", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ntfy-test-"));
  const { calls, fn } = fakeExec({
    "docker compose version": "2.20",
    "docker compose -f": "",
  });
  const res = await runSetup(
    { op: "compose-up", runtime: "docker", port: 2580 },
    { exec: fn, dataDir: dir, checkHealth: async () => "up" },
  );
  const composePath = join(dir, "docker-compose.yml");
  expect(existsSync(composePath)).toBe(true);
  expect(readFileSync(composePath, "utf8")).toContain("binwiederhier/ntfy");
  expect(calls.some((c) => c.includes("compose") && c.includes("up"))).toBe(true);
  const body = res.body as Record<string, unknown>;
  expect(body.health).toBe("up");
  expect(body.suggestedBaseUrl).toContain(":2580");
});

test("composeFileYaml uses the requested port", () => {
  expect(composeFileYaml(2580)).toContain("2580:80");
});
