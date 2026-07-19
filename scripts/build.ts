import * as esbuild from "esbuild";

async function main(): Promise<void> {
  await Deno.remove("dist", { recursive: true }).catch(() => {});
  await Deno.mkdir("dist/api", { recursive: true });
  await Deno.mkdir("dist/web", { recursive: true });

  await esbuild.build({
    entryPoints: ["packages/api/src/index.ts"],
    outfile: "dist/api/index.js",
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
  });

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

  esbuild.stop();
  console.log("Build complete: dist/api/index.js, dist/web/{index.html,app.js,app.css}");
}

await main();
