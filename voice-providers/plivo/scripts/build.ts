import { build } from "tsdown";
import { formatDeclarationFiles } from "../../../scripts/format-declarations";

async function main() {
  await build({
    clean: true,
    dts: true,
    entry: ["src/index.ts", "src/browser.ts"],
    skipNodeModulesBundle: true,
    external: ["cloudflare:workers", "plivo-browser-sdk"],
    format: "esm",
    sourcemap: true,
    fixedExtension: false
  });

  formatDeclarationFiles();

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
