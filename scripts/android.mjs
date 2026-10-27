// SPDX-License-Identifier: GPL-3.0-or-later
// Builds the Android app on any system (Windows, macOS or Linux):
//
//   npm run android:apk        a debug APK you can install on your own phone
//   npm run android:release    the release APK and Play Store bundle (.aab), signed when the
//                              INKLEAF_KEYSTORE_* variables are set (see the README)
//
// Needs the Android SDK (Android Studio installs it) and JDK 21.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = process.argv.includes('--release');
const windows = process.platform === 'win32';
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: windows });

run('node', ['scripts/build-mobile.mjs']);
run('npx', ['cap', 'sync', 'android']);

const android = path.join(root, 'mobile', 'android');
const gradle = windows ? 'gradlew.bat' : './gradlew';
if (!windows) fs.chmodSync(path.join(android, 'gradlew'), 0o755);
run(gradle, release ? ['assembleRelease', 'bundleRelease'] : ['assembleDebug'], android);

const out = path.join(android, 'app', 'build', 'outputs');
console.log('\nDone:');
for (const file of release
  ? ['apk/release/app-release.apk', 'apk/release/app-release-unsigned.apk', 'bundle/release/app-release.aab']
  : ['apk/debug/app-debug.apk']) {
  if (fs.existsSync(path.join(out, file))) console.log('  ' + path.join(out, file));
}
