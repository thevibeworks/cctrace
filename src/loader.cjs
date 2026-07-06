// CommonJS loader - runs before Claude starts
const path = require("path");
const fs = require("fs");

try {
  const preloadPath = path.join(__dirname, "..", ".cache", "preload.cjs");

  if (!fs.existsSync(preloadPath)) {
    console.error("[cctrace] Preload not found:", preloadPath);
    process.exit(1);
  }

  require(preloadPath);
} catch (error) {
  console.error("[cctrace] Loader error:", error.message);
}
