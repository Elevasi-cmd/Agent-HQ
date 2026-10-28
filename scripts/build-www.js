#!/usr/bin/env node
// Builds www/ for Capacitor: the Agent HQ office page (web/agent-hq.html) made to work offline inside the app,
// plus the phone layer (src/ bundled into www/mobile.js). Three.js and the two pixel fonts ship inside the app.
'use strict';
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), www = path.join(root, 'www');
const rel = (...p) => path.join(root, ...p);

fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(path.join(www, 'vendor'), { recursive: true }); fs.mkdirSync(path.join(www, 'fonts'), { recursive: true });

// 1. phone layer
require('esbuild').buildSync({ entryPoints: [rel('src/main.js')], bundle: true, format: 'iife', target: ['safari15'], minify: true, sourcemap: false, outfile: path.join(www, 'mobile.js'), legalComments: 'none' });
fs.copyFileSync(rel('src/mobile.css'), path.join(www, 'mobile.css'));

// 2. assets that must not depend on the network
fs.copyFileSync(rel('vendor/three.min.js'), path.join(www, 'vendor/three.min.js'));
for (const f of fs.readdirSync(rel('vendor/fonts'))) fs.copyFileSync(rel('vendor/fonts', f), path.join(www, 'fonts', f));
fs.writeFileSync(path.join(www, 'fonts/fonts.css'),
  "@font-face{font-family:'Press Start 2P';src:url(press-start-2p-latin-400-normal.woff2) format('woff2');font-display:block}\n" +
  "@font-face{font-family:'VT323';src:url(vt323-latin-400-normal.woff2) format('woff2');font-display:block}\n");

// 3. the office page
let html = fs.readFileSync(rel('web/agent-hq.html'), 'utf8');
const swap = (a, b) => { if (!html.includes(a)) throw new Error('build: expected to find ' + a.slice(0, 60)); html = html.replace(a, b); };
swap('<link rel="preconnect" href="https://fonts.googleapis.com">\n', '');
swap('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Press+Start+2P&family=VT323&display=swap">', '<link rel="stylesheet" href="fonts/fonts.css">');
swap('<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>', '<script src="vendor/three.min.js"></script>');
const head = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">\n<meta name="color-scheme" content="dark">\n';
const mine = '<link rel="stylesheet" href="mobile.css">\n<script src="mobile.js"></script>\n';
// mobile.js must run before the office script so the page finds HQ_TRANSPORT when it starts
html = head + html.replace('<style>', mine + '<style>');
if (/https?:\/\/(fonts\.googleapis|cdnjs)/.test(html)) throw new Error('build: a network dependency is left in the page');
fs.writeFileSync(path.join(www, 'index.html'), html);
console.log('www built:', fs.readdirSync(www).join(', '));
