import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // This app has its own package-lock.json inside a repo that also has one at
  // the root, so Next guesses the wrong workspace root and warns on every
  // start. Pinning it to web/ silences that and keeps file tracing correct.
  outputFileTracingRoot: here,

  // The Express app owns the DB, the pillars and the Meta webhook. This UI is a
  // thin client that talks to it over HTTP, so nothing here needs better-sqlite3
  // (a native module Next's bundler handles badly).
  env: {
    BOT_API_BASE: process.env.BOT_API_BASE ?? "http://localhost:3000",
  },
};

export default nextConfig;
