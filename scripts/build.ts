import * as esbuild from "esbuild";
import { renderIconImage } from "../packages/extension/src/icons/render.ts";
import { encodePng } from "../packages/extension/src/icons/png.ts";

const ICON_SIZES = [16, 32, 48, 128];

async function buildApi(): Promise<void> {
  await Deno.mkdir("dist/api", { recursive: true });
  await esbuild.build({
    entryPoints: ["packages/api/src/index.ts"],
    outfile: "dist/api/index.js",
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
  });
}

async function buildWeb(): Promise<void> {
  await Deno.mkdir("dist/web", { recursive: true });
  await esbuild.build({
    entryPoints: ["packages/web/src/main.tsx"],
    outdir: "dist/web",
    entryNames: "app",
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    jsx: "automatic",
    jsxImportSource: "preact",
  });
  await Deno.copyFile("packages/web/index.html", "dist/web/index.html");
}

// The extension is bundled as self-contained IIFEs (not ESM), since MV3
// service workers/content scripts avoid the extra complexity of module
// loading — see packages/extension/manifest.json's plain (non-"type":
// "module") service_worker declaration.
async function buildExtension(): Promise<void> {
  await Deno.mkdir("dist/extension/icons", { recursive: true });

  await esbuild.build({
    entryPoints: ["packages/extension/src/background.ts"],
    outfile: "dist/extension/background.js",
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: true,
  });

  await esbuild.build({
    entryPoints: [
      "packages/extension/src/content/content-page.ts",
      "packages/extension/src/content/content-selection.ts",
    ],
    outdir: "dist/extension",
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: true,
  });

  await esbuild.build({
    entryPoints: {
      options: "packages/extension/src/options.tsx",
      popup: "packages/extension/src/popup.tsx",
    },
    outdir: "dist/extension",
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: true,
    jsx: "automatic",
    jsxImportSource: "preact",
  });

  await Deno.copyFile("packages/extension/manifest.json", "dist/extension/manifest.json");
  await Deno.copyFile("packages/extension/options.html", "dist/extension/options.html");
  await Deno.copyFile("packages/extension/popup.html", "dist/extension/popup.html");

  for (const size of ICON_SIZES) {
    const png = await encodePng(renderIconImage(size));
    await Deno.writeFile(`dist/extension/icons/icon${size}.png`, png);
  }
}

async function main(): Promise<void> {
  const extensionOnly = Deno.args.includes("--extension-only");

  if (extensionOnly) {
    await Deno.remove("dist/extension", { recursive: true }).catch(() => {});
    await buildExtension();
    esbuild.stop();
    console.log("Build complete: dist/extension/");
    return;
  }

  await Deno.remove("dist", { recursive: true }).catch(() => {});
  await buildApi();
  await buildWeb();
  await buildExtension();

  esbuild.stop();
  console.log(
    "Build complete: dist/api/index.js, dist/web/{index.html,app.js,app.css}, dist/extension/",
  );
}

await main();
