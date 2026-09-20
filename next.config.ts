import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native modules, WASM grammars and analyzers must be loaded from node_modules, not bundled.
  serverExternalPackages: [
    "better-sqlite3", "web-tree-sitter", "pdfkit", "fontkit", "yauzl", "typescript", "eslint", "@typescript-eslint/parser",
    "tree-sitter-python", "tree-sitter-go", "tree-sitter-java", "tree-sitter-c-sharp", "tree-sitter-typescript", "tree-sitter-javascript",
    "tree-sitter-css", "tree-sitter-html", "tree-sitter-json", "tree-sitter-bash", "tree-sitter-ruby", "tree-sitter-rust", "tree-sitter-php",
  ],
  poweredByHeader: false,
  // The app is addressed as http://brody:3003 (add "127.0.0.1 brody" to /etc/hosts).
  allowedDevOrigins: ["brody"],
  experimental: {
    // Because the app uses a proxy (the host allow-list), Next buffers every request body and, by default, silently
    // truncates it at 10 MB, which breaks large folder uploads with "could not be read as a multipart form". Buffer up
    // to the app's own upload limit instead (MAX_UPLOAD_BYTES, 200 MB by default); the upload route enforces it.
    proxyClientMaxBodySize: Number(process.env.MAX_UPLOAD_BYTES) || 200 * 1024 * 1024,
    // Lets constrained CI/Docker builders cap parallel workers (for example NEXT_BUILD_CPUS=2).
    ...(process.env.NEXT_BUILD_CPUS ? { cpus: Number(process.env.NEXT_BUILD_CPUS) } : {}),
  },
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Frame-Options", value: "DENY" },
    ] }];
  },
};

export default nextConfig;
