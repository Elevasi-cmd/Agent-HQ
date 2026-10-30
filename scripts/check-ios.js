#!/usr/bin/env node
// Preflight for the cloud build: checks the generated iOS project before any signing or compiling happens, so a
// mistake fails in seconds with a plain message instead of after a long Xcode run. Runs on Linux, Windows or macOS.
// It cannot compile Swift or sign anything; that only happens on Codemagic's Macs.
//   npm run check        (after: npm run build && node scripts/ios-config.js && npx cap sync ios)
'use strict';
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const rd = p => fs.readFileSync(path.join(root, p), 'utf8');
const has = p => fs.existsSync(path.join(root, p));
const problems = [], notes = [];
const check = (ok, msg) => { if (!ok) problems.push(msg); };

// Plain-XML plist reader: enough for the keys we set (string, true/false, array of strings, dict of booleans).
function plistKeys(xml) {
  const out = {}; const top = xml.slice(xml.indexOf('<dict>') + 6, xml.lastIndexOf('</dict>'));
  const re = /<key>([^<]+)<\/key>\s*(<string>([^<]*)<\/string>|<(true|false)\/>|<array>([\s\S]*?)<\/array>|<array\/>|<dict>([\s\S]*?)<\/dict>|<integer>(\d+)<\/integer>)/g;
  let m, depth = 0;
  while ((m = re.exec(top))) { out[m[1]] = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] === 'true' : m[5] !== undefined ? m[5] : m[6] !== undefined ? m[6] : m[7] !== undefined ? +m[7] : ''; }
  return out;
}

const pkg = JSON.parse(rd('package.json'));
const cap = JSON.parse(rd('capacitor.config.json'));
const BUNDLE_ID = process.env.BUNDLE_ID || cap.appId;

// 1. web layer
check(has('www/index.html') && has('www/mobile.js'), 'www/ is missing: run "npm run build".');
if (has('www/index.html')) {
  const html = rd('www/index.html');
  check(!/https?:\/\/(fonts\.googleapis|fonts\.gstatic|cdnjs\.cloudflare)\.com/.test(html), 'The bundled office still loads fonts or three.js from the internet; it must open with no network.');
  check(/viewport-fit=cover/.test(html), 'The viewport meta for the notch is missing.');
  check(html.includes('mobile.js'), 'The phone layer (mobile.js) is not loaded by the office page.');
}
// 2. no secrets in what ships inside the app
for (const f of ['www/index.html', 'www/mobile.js', 'capacitor.config.json'].filter(has)) {
  const t = rd(f);
  check(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t), `${f} contains a private key.`);
  check(!/\b(sk-(proj-)?[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,})\b/.test(t), `${f} contains what looks like an API key.`);
}
// 3. native project, as Capacitor generated it
check(has('ios/App/App/public/index.html'), 'ios/App/App/public is missing: run "npx cap sync ios".');
check(has('ios/App/App/capacitor.config.json'), 'ios/App/App/capacitor.config.json is missing: run "npx cap sync ios".');
if (has('ios/App/App/capacitor.config.json')) check(JSON.parse(rd('ios/App/App/capacitor.config.json')).appId === BUNDLE_ID, 'The synced Capacitor config has a different bundle id: run ios-config then cap sync again.');
const spm = has('ios/App/CapApp-SPM/Package.swift') ? rd('ios/App/CapApp-SPM/Package.swift') : '';
for (const dep of Object.keys(pkg.dependencies).filter(d => d !== '@capacitor/core' && d !== '@capacitor/ios')) check(spm.includes(`node_modules/${dep}"`), `${dep} is not in the Swift package list: run "npx cap sync ios".`);
const capVer = pkg.dependencies['@capacitor/ios'];
check(spm.includes(`capacitor-swift-pm.git", exact: "${capVer}"`), `Capacitor's Swift package is not pinned to ${capVer}.`);

const pbx = rd('ios/App/App.xcodeproj/project.pbxproj');
const ids = [...pbx.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)].map(m => m[1]);
check(ids.length >= 2 && ids.every(i => i === BUNDLE_ID), `Xcode bundle id is not ${BUNDLE_ID} in every configuration (found ${[...new Set(ids)].join(', ')}).`);
check(/VERSIONING_SYSTEM = "apple-generic";/.test(pbx), 'Apple Generic versioning is off, so the build number cannot be set.');
check(!/TARGETED_DEVICE_FAMILY = (?!1;)/.test(pbx), 'The app is set to build for iPad too.');
check((pbx.match(/PrivacyInfo\.xcprivacy/g) || []).length >= 4 && has('ios/App/App/PrivacyInfo.xcprivacy'), 'The privacy manifest is missing or not added to the app target.');
const PUSH = String(process.env.PUSH_ENABLED || 'false') === 'true';
check(PUSH === /CODE_SIGN_ENTITLEMENTS = App\/App\.entitlements;/.test(pbx) && PUSH === has('ios/App/App/App.entitlements'), `Push setting (${PUSH}) does not match the entitlements in the project: run ios-config again.`);
// every object id in the project is defined exactly once
const defs = [...pbx.matchAll(/^\t\t([0-9A-F]{24}) \/\*.*?\*\/ = \{/gm)].map(m => m[1]);
check(defs.length === new Set(defs).size, 'The Xcode project defines an object twice.');
let opens = 0; for (const ch of pbx) { if (ch === '{') opens++; else if (ch === '}') opens--; if (opens < 0) break; }
check(opens === 0, 'The Xcode project file has unbalanced braces.');

const info = plistKeys(rd('ios/App/App/Info.plist'));
check(info.CFBundleShortVersionString === '$(MARKETING_VERSION)' && info.CFBundleVersion === '$(CURRENT_PROJECT_VERSION)', 'Info.plist version keys should come from the build settings.');
check(typeof info.NSMicrophoneUsageDescription === 'string' && info.NSMicrophoneUsageDescription.length > 20, 'Info.plist needs a microphone explanation (iOS stops the app without it when recording).');
check(info.ITSAppUsesNonExemptEncryption === false, 'Info.plist should declare standard encryption only (ITSAppUsesNonExemptEncryption = NO), or every build waits for an export question.');
check(!/NSAllowsArbitraryLoads<\/key>\s*<true/.test(rd('ios/App/App/Info.plist')), 'Info.plist allows any insecure connection; only local networking is needed.');
check(PUSH === (typeof info.UIBackgroundModes === 'string' && info.UIBackgroundModes.includes('remote-notification')), 'Background mode for alerts does not match the push setting.');
const priv = plistKeys(rd('ios/App/App/PrivacyInfo.xcprivacy'));
check(priv.NSPrivacyTracking === false && /NSPrivacyAccessedAPICategoryUserDefaults[\s\S]*CA92\.1/.test(rd('ios/App/App/PrivacyInfo.xcprivacy')), 'The privacy manifest must declare UserDefaults (CA92.1) and no tracking.');

// 4. app icon: 1024 x 1024, no transparency (App Store Connect rejects an icon with an alpha channel)
const iconDir = 'ios/App/App/Assets.xcassets/AppIcon.appiconset';
const iconJson = JSON.parse(rd(iconDir + '/Contents.json'));
const icon = (iconJson.images || []).find(i => i.size === '1024x1024' && i.filename);
check(!!icon, 'No 1024 x 1024 app icon.');
if (icon) {
  const b = fs.readFileSync(path.join(root, iconDir, icon.filename));
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20), colorType = b[25];
  check(b.toString('ascii', 1, 4) === 'PNG' && w === 1024 && h === 1024, 'The app icon is not a 1024 x 1024 PNG.');
  check(colorType === 2 || colorType === 0, 'The app icon has transparency; App Store Connect rejects that.');
}

// 5. pipeline values
const yml = rd('codemagic.yaml');
check(/BUNDLE_ID: "([^"]+)"/.exec(yml) && /BUNDLE_ID: "([^"]+)"/.exec(yml)[1] === cap.appId, 'codemagic.yaml BUNDLE_ID differs from capacitor.config.json appId.');
if (process.env.CI) check(/^[1-9]\d{5,}$/.test(process.env.APP_STORE_APPLE_ID || ''), 'APP_STORE_APPLE_ID is not set to your app\'s Apple ID (a number, from App Store Connect > App Information).');

if (problems.length) { console.error('iOS preflight found problems:\n- ' + problems.join('\n- ')); process.exit(1); }
console.log(`iOS preflight passed: ${BUNDLE_ID} · Capacitor ${capVer} · ${Object.keys(pkg.dependencies).length - 2} plugins · push ${PUSH ? 'on' : 'off'}${notes.length ? '\n  ' + notes.join('\n  ') : ''}`);
