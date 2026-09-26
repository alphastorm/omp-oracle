#!/usr/bin/env node
// Purpose: Render the editable HTML brand sources in assets/ into the committed PNGs.
// Responsibilities: Locate Chrome, screenshot each source headlessly at its logical size and device
//   scale, verify the PNG dimensions, then replace the committed PNG, or with --check compare against
//   it without writing.
// Scope: Artwork maintenance only; neither the extension nor the local gate runs this. It needs Chrome
//   and network access for the artwork webfonts that assets/brand.css imports.
// Usage: npm run render:assets [-- [banner|og ...] [--check] [--chrome <path>]]
// Invariants/Assumptions: A committed PNG is replaced only by a complete render at the expected
//   dimensions. Byte-identical output is expected only from the Chrome build and fonts that produced
//   the committed PNG, so --check is a same-machine staleness check, not a cross-platform one.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const ASSETS = fileURLToPath(new URL("../assets/", import.meta.url));
// Logical CSS size and device scale of each assets/<name>.html; the PNG is (width × scale) × (height × scale).
const TARGETS = {
  banner: { width: 1280, height: 320, scale: 2 },
  og: { width: 1280, height: 640, scale: 1 },
};
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function findChrome(explicit) {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`--chrome ${explicit} does not exist`);
    return explicit;
  }
  const onPath = (name) => (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, name));
  const found = [
    process.env.CHROME,
    ...["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].flatMap(onPath),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ].find((candidate) => candidate && existsSync(candidate));
  if (!found) throw new Error("Chrome or Chromium not found; pass --chrome <path> or set CHROME");
  return found;
}

function pngSize(bytes, label) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString("latin1", 12, 16) !== "IHDR") {
    throw new Error(`${label} is not a PNG`);
  }
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

function render(chrome, name, check) {
  const { width, height, scale } = TARGETS[name];
  const destination = join(ASSETS, `${name}.png`);
  const dir = mkdtempSync(join(tmpdir(), `omp-oracle-${name}-`));
  try {
    const output = join(dir, `${name}.png`);
    const result = spawnSync(chrome, [
      "--headless=new",
      "--hide-scrollbars",
      "--disable-gpu",
      "--force-color-profile=srgb",
      `--force-device-scale-factor=${scale}`,
      `--window-size=${width},${height}`,
      "--virtual-time-budget=5000",
      `--screenshot=${output}`,
      pathToFileURL(join(ASSETS, `${name}.html`)).href,
    ], { encoding: "utf8", timeout: 60_000 });
    if (result.status !== 0 || !existsSync(output)) {
      throw new Error(`${name}: Chrome exited with ${result.error?.message ?? result.status ?? result.signal}: ${result.stderr?.trim() ?? ""}`);
    }
    const rendered = readFileSync(output);
    const [renderedWidth, renderedHeight] = pngSize(rendered, `${name} render`);
    if (renderedWidth !== width * scale || renderedHeight !== height * scale) {
      throw new Error(`${name}: expected ${width * scale}x${height * scale}, rendered ${renderedWidth}x${renderedHeight}`);
    }
    if (check) {
      if (!existsSync(destination) || !readFileSync(destination).equals(rendered)) {
        throw new Error(`${name}: assets/${name}.png does not match assets/${name}.html; run npm run render:assets`);
      }
    } else {
      copyFileSync(output, destination);
    }
    console.log(`${name}: ${renderedWidth}x${renderedHeight}${check ? ", matches the committed PNG" : ""}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { check: { type: "boolean", default: false }, chrome: { type: "string" } },
});
const unknown = positionals.filter((name) => !Object.hasOwn(TARGETS, name));
if (unknown.length > 0) {
  console.error(`Unknown target ${unknown.join(", ")}; expected ${Object.keys(TARGETS).join(" or ")}`);
  process.exit(2);
}
try {
  const chrome = findChrome(values.chrome);
  for (const name of positionals.length > 0 ? positionals : Object.keys(TARGETS)) render(chrome, name, values.check);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
