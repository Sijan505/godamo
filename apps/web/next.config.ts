import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the root to this app; otherwise Turbopack picks up the monorepo's
  // root lockfile and watches the whole repo (including the API).
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
