/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The voice bridge runs in the custom server (server.mjs), not in a route
  // handler, so nothing here needs edge runtime.
  serverExternalPackages: ["ws"],
};

export default nextConfig;
