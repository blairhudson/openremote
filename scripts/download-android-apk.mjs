import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const releasesDir = path.join(process.cwd(), "dist", "releases");
const buildJsonPath = path.join(releasesDir, "android-apk-build.json");
const builds = JSON.parse(await readFile(buildJsonPath, "utf8"));
const build = Array.isArray(builds) ? builds[0] : builds;
const url = build?.artifacts?.applicationArchiveUrl ?? build?.artifacts?.buildUrl;

if (!url) {
  throw new Error(`No APK artifact URL found in ${buildJsonPath}`);
}

const version = build.appVersion ?? "unknown";
const apkPath = path.join(releasesDir, `openremote-v${version}-android.apk`);
const response = await fetch(url);

if (!response.ok) {
  throw new Error(`Failed to download APK: ${response.status} ${response.statusText}`);
}

await mkdir(releasesDir, { recursive: true });
await writeFile(apkPath, Buffer.from(await response.arrayBuffer()));
console.log(apkPath);
