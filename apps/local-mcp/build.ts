import tailwindcss from "bun-plugin-tailwind";

const result = await Bun.build({
  entrypoints: ["src/index.ts", "src/cli.ts"],
  outdir: "dist",
  target: "bun",
  naming: {
    entry: "[name].[ext]",
    chunk: "[name]-[hash].[ext]",
    asset: "ui/[name].[ext]",
  },
  plugins: [tailwindcss],
  external: ["@tokenspace/compiler", "@tokenspace/sdk", "@tokenspace/runtime-core", "esbuild"],
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

for (const output of result.outputs) {
  const size = output.size;
  const label =
    size >= 1024 * 1024
      ? `${(size / (1024 * 1024)).toFixed(2)} MB`
      : size >= 1024
        ? `${(size / 1024).toFixed(2)} KB`
        : `${size} bytes`;
  console.log(`  ${output.path.replace(`${process.cwd()}/`, "")}  ${label}`);
}
