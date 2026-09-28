import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // quickjs-emscripten ships WASM; the bundler mishandles it unless it's
  // left external to the server bundle.
  serverExternalPackages: ["quickjs-emscripten"],
};

export default nextConfig;
