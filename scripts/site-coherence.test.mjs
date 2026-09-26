// Purpose: Keep the public site deployable as written.
// Responsibilities: Every asset a site page references exists once the Pages workflow has staged the
//   canonical brand assets; an asset change redeploys the site; the social preview names a real PNG of
//   the size the page declares; the sitemap, robots.txt, and canonical links agree on the site's pages.
// Scope: Static checks of site/, assets/, and .github/workflows/pages.yml; no network, no browser.
// Usage: npm run test:site (part of npm run verify:oracle).
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SITE = join(ROOT, "site");
const ORIGIN = "https://alphastorm.github.io/omp-oracle/";
const WORKFLOW = readFileSync(join(ROOT, ".github/workflows/pages.yml"), "utf8");
// Site-relative name → canonical source, read from the workflow's `cp <source> site/<name>` lines.
const STAGED = new Map([...WORKFLOW.matchAll(/^\s*cp (\S+) site\/(\S+)$/gmu)].map(([, source, name]) => [name, source]));

const toPosix = (path) => path.split(sep).join("/");

function sitePages() {
  return readdirSync(SITE, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === "index.html")
    .map((entry) => {
      const dir = toPosix(relative(SITE, entry.parentPath));
      return { path: join(entry.parentPath, entry.name), dir, url: dir === "" ? ORIGIN : `${ORIGIN}${dir}/` };
    })
    .sort((a, b) => a.url.localeCompare(b.url));
}

/** The file that the deployment serves at a site-relative path, or undefined when nothing will. */
function deployedFile(sitePath) {
  const staged = STAGED.get(sitePath);
  const file = staged === undefined
    ? join(SITE, sitePath === "" || sitePath.endsWith("/") ? `${sitePath}index.html` : sitePath)
    : join(ROOT, staged);
  return existsSync(file) ? file : undefined;
}

test("the Pages workflow redeploys when a staged asset's canonical source changes", () => {
  assert(STAGED.size > 0, "pages.yml has no `cp <source> site/<name>` staging lines");
  const triggers = WORKFLOW.split(/^\s*paths:\s*$/mu)[1]?.split(/^\s*workflow_dispatch:/mu)[0] ?? "";
  const watched = new Set([...triggers.matchAll(/^\s*- (\S+)\s*$/gmu)].map(([, path]) => path));
  for (const [name, source] of STAGED) {
    assert(watched.has(source), `pages.yml stages site/${name} from ${source} but does not redeploy when it changes`);
  }
});

test("every asset a site page references exists after staging", () => {
  for (const page of sitePages()) {
    const html = readFileSync(page.path, "utf8");
    const label = toPosix(relative(ROOT, page.path));
    for (const [, target] of html.matchAll(/\b(?:src|href)="([^"#?]*)/gu)) {
      if (target === "" || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(target)) continue;
      const sitePath = posix.normalize(posix.join(page.dir, target));
      assert(!sitePath.startsWith("../"), `${label} references ${target} outside site/`);
      assert(deployedFile(sitePath), `${label} references ${target}, which neither site/ nor the Pages staging provides`);
    }
    for (const [, url] of html.matchAll(/\bcontent="([^"]*)"/gu)) {
      if (url.startsWith(ORIGIN)) assert(deployedFile(url.slice(ORIGIN.length)), `${label} names ${url}, which the deployment does not serve`);
    }
  }
});

test("the social preview names a deployed PNG of the size the page declares", () => {
  const html = readFileSync(join(SITE, "index.html"), "utf8");
  const meta = Object.fromEntries([...html.matchAll(/<meta property="(og:image(?::\w+)?)" content="([^"]*)"/gu)]
    .map(([, key, value]) => [key, value]));
  const image = meta["og:image"];
  assert(image?.startsWith(ORIGIN), "site/index.html must name an og:image under the site origin");
  const file = deployedFile(image.slice(ORIGIN.length));
  assert(file, `og:image ${image} is not deployed`);
  const bytes = readFileSync(file);
  assert.equal(bytes.toString("latin1", 12, 16), "IHDR", `${toPosix(relative(ROOT, file))} is not a PNG`);
  assert.deepEqual(
    [bytes.readUInt32BE(16), bytes.readUInt32BE(20)],
    [Number(meta["og:image:width"]), Number(meta["og:image:height"])],
    `${toPosix(relative(ROOT, file))} differs from the og:image:width/height the page declares`,
  );
});

test("sitemap, robots.txt, and canonical links name exactly the site pages", () => {
  const pages = sitePages();
  const sitemap = readFileSync(join(SITE, "sitemap.xml"), "utf8");
  assert.deepEqual([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/gu)].map(([, loc]) => loc).sort(), pages.map((page) => page.url));
  assert.match(readFileSync(join(SITE, "robots.txt"), "utf8"), new RegExp(`^Sitemap: ${ORIGIN}sitemap\\.xml$`, "mu"));
  for (const page of pages) {
    const canonical = [...readFileSync(page.path, "utf8").matchAll(/<link rel="canonical" href="([^"]*)"/gu)].map(([, href]) => href);
    assert.deepEqual(canonical, [page.url], `${toPosix(relative(ROOT, page.path))} canonical URL`);
  }
});
