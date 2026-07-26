/** @type {import('next').NextConfig} */
const nextConfig = {
  // The Express app owns the DB, the pillars and the Meta webhook. This UI is a
  // thin client that talks to it over HTTP, so nothing here needs better-sqlite3
  // (a native module Next's bundler handles badly).
  env: {
    BOT_API_BASE: process.env.BOT_API_BASE ?? "http://localhost:3000",
  },
};

export default nextConfig;
