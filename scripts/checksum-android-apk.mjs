import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const releasesDir = path.join(process.cwd(), "dist", "releases");
const builds = JSON.parse(await readFile(path.join(releasesDir, "android-apk-build.json"), "utf8"));
const build = Array.isArray(builds) ? builds[0] : builds;
const version = build?.appVersion;

if (!version) {
  throw new Error("No appVersion found in Android APK build JSON");
}

const apkPath = path.join(releasesDir, `openremote-v${version}-android.apk`);
const checksum = createHash("sha256").update(await readFile(apkPath)).digest("hex");

console.log(`${checksum}  ${apkPath}`);
