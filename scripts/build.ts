import { existsSync } from "node:fs";

const jobs: Array<{
  entry: string;
  outdir: string;
  naming: string;
  target: "node" | "browser";
  external: string[];
}> = [
  {
    entry: "src/worker.ts",
    outdir: "dist",
    naming: "worker.js",
    target: "node",
    external: ["react", "react-dom"],
  },
  {
    entry: "src/manifest.ts",
    outdir: "dist",
    naming: "manifest.js",
    target: "node",
    external: ["@paperclipai/plugin-sdk"],
  },
  {
    entry: "src/ui/index.tsx",
    outdir: "dist/ui",
    naming: "index.[ext]",
    target: "browser",
    external: [
      "@paperclipai/plugin-sdk/ui",
      "@paperclipai/plugin-sdk/ui/hooks",
      "react",
      "react-dom",
      "react/jsx-runtime",
    ],
  },
];

let failed = false;
for (const job of jobs) {
  if (!existsSync(job.entry)) {
    console.warn(`skip ${job.entry} (missing)`);
    continue;
  }
  const result = await Bun.build({
    entrypoints: [job.entry],
    outdir: job.outdir,
    naming: job.naming,
    target: job.target,
    format: "esm",
    sourcemap: "external",
    external: job.external,
  });
  if (!result.success) {
    failed = true;
    for (const msg of result.logs) console.error(msg);
  } else {
    console.log(`built ${job.entry} -> ${job.outdir}/${job.naming}`);
  }
}
if (failed) process.exit(1);
