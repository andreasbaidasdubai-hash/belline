/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The voice bridge runs in the custom server (server.mjs), not in a route
  // handler, so nothing here needs edge runtime.
  serverExternalPackages: ["ws"],
};

/*
 * A note for whoever builds this on a Windows machine next.
 *
 * This checkout lives inside OneDrive, which turns synced files into cloud
 * placeholders — reparse points that Node's `readlink` rejects with EINVAL.
 * Next writes thousands of small files into .next and reads them straight
 * back, so a sync pass landing mid-build fails it on a file that plainly
 * exists: "Cannot find module for page: /billing", ENOENT, moments after the
 * same build said "Compiled successfully". It fails on a different page each
 * time, which is the tell.
 *
 * Two obvious fixes do not work, so do not spend the afternoon on them again:
 *
 *   `distDir` outside the tree breaks the tsconfig path that resolves
 *   .next/types, and type-checking fails instead.
 *
 *   A junction from .next to somewhere outside OneDrive breaks module
 *   resolution: Node resolves from the *real* path, walks up from
 *   %LOCALAPPDATA%\Temp looking for node_modules, and cannot find
 *   react/jsx-runtime.
 *
 * What actually fixes it is excluding the folder from syncing, in the OneDrive
 * settings, or keeping the checkout outside OneDrive altogether. Until then:
 * re-run the build, it passes roughly every other attempt.
 *
 * Railway builds in a container with no OneDrive, so production never sees
 * any of this.
 */

export default nextConfig;
