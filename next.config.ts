import type { NextConfig } from "next";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
  outputFileTracingIncludes: { '/*': ['./scripts/pdf-source-worker.mjs', './node_modules/pdfjs-dist/legacy/build/*.mjs', './node_modules/@napi-rs/canvas/**/*'] },
};

export default nextConfig;
