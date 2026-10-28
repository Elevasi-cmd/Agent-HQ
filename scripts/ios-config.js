#!/usr/bin/env node
// Applies Agent HQ's settings to the generated iOS project (bundle id, version, microphone text, push, transport rules).
// Runs in the Codemagic build and works anywhere Node runs: no Xcode needed. Safe to run more than once.
//   BUNDLE_ID=com.you.agenthq PUSH_ENABLED=true node scripts/ios-config.js
'use strict';
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const cfgFile = path.join(root, 'capacitor.config.json');
const cap = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const BUNDLE_ID = process.env.BUNDLE_ID || cap.appId;
const APP_NAME = process.env.APP_NAME || cap.appName || 'Agent HQ';
const PUSH = String(process.env.PUSH_ENABLED || 'false') === 'true';
const VERSION = process.env.MARKETING_VERSION || pkg.version;
if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(BUNDLE_ID)) throw new Error('BUNDLE_ID looks wrong: ' + BUNDLE_ID);

// capacitor.config.json
cap.appId = BUNDLE_ID; cap.appName = APP_NAME; fs.writeFileSync(cfgFile, JSON.stringify(cap, null, 2) + '\n');

// Xcode project build settings
const pbx = path.join(root, 'ios/App/App.xcodeproj/project.pbxproj');
let p = fs.readFileSync(pbx, 'utf8');
p = p.replace(/PRODUCT_BUNDLE_IDENTIFIER = [^;]+;/g, `PRODUCT_BUNDLE_IDENTIFIER = ${BUNDLE_ID};`);
p = p.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${VERSION};`);
// agvtool (used by the build to bump the build number) needs Apple Generic versioning on the app target
p = p.replace(/(\n(\t+)CURRENT_PROJECT_VERSION = [^;]+;)(?![\s\S]{0,400}?VERSIONING_SYSTEM)/g, (m, line, tabs) => `${line}\n${tabs}VERSIONING_SYSTEM = "apple-generic";`);
const ent = path.join(root, 'ios/App/App/App.entitlements');
p = p.replace(/\n\t+CODE_SIGN_ENTITLEMENTS = [^;]+;/g, '');
if (PUSH) {
  p = p.replace(/(\n(\t+)CODE_SIGN_STYLE = [^;]+;)/g, (m, line, tabs) => `${line}\n${tabs}CODE_SIGN_ENTITLEMENTS = App/App.entitlements;`);
  fs.writeFileSync(ent, '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n\t<key>aps-environment</key>\n\t<string>production</string>\n</dict>\n</plist>\n');
} else if (fs.existsSync(ent)) fs.unlinkSync(ent);
fs.writeFileSync(pbx, p);

// Info.plist
const plistFile = path.join(root, 'ios/App/App/Info.plist');
let x = fs.readFileSync(plistFile, 'utf8');
function setKey(key, valueXml) {
  const re = new RegExp(`\\n?\\s*<key>${key}</key>\\s*(<(string|integer)>[^<]*</\\2>|<(true|false)/>|<array>[\\s\\S]*?</array>|<dict>[\\s\\S]*?</dict>)`);
  x = x.replace(re, '');
  if (valueXml == null) return;
  const i = x.lastIndexOf('</dict>');
  x = x.slice(0, i) + `\t<key>${key}</key>\n\t${valueXml}\n` + x.slice(i);
}
setKey('CFBundleDisplayName', `<string>${APP_NAME}</string>`);
setKey('NSMicrophoneUsageDescription', '<string>Atarah listens only after you tap the mic button. Your voice goes to your own desktop, not to a third party.</string>');
setKey('ITSAppUsesNonExemptEncryption', '<false/>');
setKey('NSAppTransportSecurity', '<dict>\n\t\t<key>NSAllowsLocalNetworking</key>\n\t\t<true/>\n\t</dict>');
setKey('UIBackgroundModes', PUSH ? '<array>\n\t\t<string>remote-notification</string>\n\t</array>' : null);
fs.writeFileSync(plistFile, x);

console.log(`iOS project set: ${APP_NAME} · ${BUNDLE_ID} · version ${VERSION} · push ${PUSH ? 'on' : 'off'}`);
