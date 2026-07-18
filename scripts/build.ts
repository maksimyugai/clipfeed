import * as esbuild from "esbuild";

async function copyDir(src: string, dest: string): Promise<void> {
  await Deno.mkdir(dest, { recursive: true });
  for await (const entry of Deno.readDir(src)) {
    const srcPath = `${src}/${entry.name}`;
    const destPath = `${dest}/${entry.name}`;
    if (entry.isDirectory) {
      await copyDir(srcPath, destPath);
    } else {
      await Deno.copyFile(srcPath, destPath);
    }
  }
}

async function main(): Promise<void> {
  await Deno.remove("dist", { recursive: true }).catch(() => {});
  await Deno.mkdir("dist/api", { recursive: true });

  await esbuild.build({
    entryPoints: ["packages/api/src/index.ts"],
    outfile: "dist/api/index.js",
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
  });

  await copyDir("packages/web", "dist/web");

  esbuild.stop();
  console.log("Build complete: dist/api/index.js, dist/web/");
}

await main();
