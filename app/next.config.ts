import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    // The marketing site (app/public/landing/index.html) is the only landing page. Serve it at
    // "/" before the app router so the URL stays clean; the console lives at /app.
    return {
      beforeFiles: [
        { source: "/", destination: "/landing/index.html" },
        { source: "/landing", destination: "/landing/index.html" },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
