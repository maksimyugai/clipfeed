import * as esbuild from "esbuild";
import { renderIconImage } from "../packages/extension/src/icons/render.ts";
import { encodePng } from "../packages/extension/src/icons/png.ts";

const ICON_SIZES = [16, 32, 48, 128];
// Favicon (32x32, the size browsers actually request) + apple-touch-icon
// (192x192 — Apple's own guidance is 180x180, but that's not a multiple of
// the icon generator's 16px grid; 192 scales down cleanly on every device
// that matters and browsers resize apple-touch-icon links regardless).
const FAVICON_SIZE = 32;
const APPLE_TOUCH_ICON_SIZE = 192;

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
  await Deno.mkdir("dist/web/fonts", { recursive: true });
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
    // @font-face url(/fonts/...) is a site-root path served by the ASSETS
    // binding at runtime, not a bundle-relative import — external stops
    // esbuild from trying (and failing) to resolve it from disk.
    external: ["/fonts/*"],
  });
  await Deno.copyFile("packages/web/index.html", "dist/web/index.html");
  for await (const entry of Deno.readDir("packages/web/fonts")) {
    if (entry.isFile && entry.name.endsWith(".woff2")) {
      await Deno.copyFile(`packages/web/fonts/${entry.name}`, `dist/web/fonts/${entry.name}`);
    }
  }

  // Reuses the extension's procedural "cf" monogram generator (see
  // packages/extension/src/icons/render.ts) instead of committing a binary
  // asset — same gradient icon, just two more sizes for the web favicon /
  // apple-touch-icon referenced from index.html.
  const faviconPng = await encodePng(renderIconImage(FAVICON_SIZE));
  await Deno.writeFile("dist/web/favicon-32.png", faviconPng);
  const appleTouchIconPng = await encodePng(renderIconImage(APPLE_TOUCH_ICON_SIZE));
  await Deno.writeFile("dist/web/apple-touch-icon.png", appleTouchIconPng);
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
