#!/usr/bin/env python3
"""Select a cloud-Mac App Store profile and verify effective Release settings."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
PROJECT = 'ios/App/App.xcodeproj'


def run(args):
    return subprocess.run(args, cwd=ROOT, check=True, capture_output=True).stdout


def rejection(p, bundle, identities, now, push=False, team=None):
    ent = p.get('Entitlements', {})
    teams = p.get('TeamIdentifier', [])
    if not teams or (team and team not in teams):
        return 'wrong or missing Apple team'
    prefixes = p.get('ApplicationIdentifierPrefix', teams)
    if ent.get('application-identifier') not in [x + '.' + bundle for x in prefixes]:
        return 'bundle identifier does not match exactly'
    expiry = p.get('ExpirationDate')
    if not isinstance(expiry, dt.datetime) or expiry.replace(tzinfo=dt.timezone.utc) <= now:
        return 'profile expired or expiration missing'
    if ent.get('get-task-allow') is not False or p.get('ProvisionedDevices') is not None or p.get('ProvisionsAllDevices'):
        return 'not an App Store distribution profile'
    if push and ent.get('aps-environment') != 'production':
        return 'production push entitlement missing'
    certs = {hashlib.sha1(c).hexdigest().upper() for c in p.get('DeveloperCertificates', [])}
    if not certs.intersection(identities):
        return 'no matching valid signing identity (certificate plus private key) in keychain'
    if not p.get('Name') or not p.get('UUID'):
        return 'profile name or UUID missing'
    return None


def verify_settings(s, p, bundle):
    issues = []
    if s.get('PRODUCT_BUNDLE_IDENTIFIER') != bundle:
        issues.append('Release bundle ID differs from BUNDLE_ID')
    if s.get('DEVELOPMENT_TEAM') not in p['TeamIdentifier']:
        issues.append('Release Apple team differs from the profile')
    if s.get('PROVISIONING_PROFILE_SPECIFIER') not in (p['Name'], p['UUID']) and s.get('PROVISIONING_PROFILE') != p['UUID']:
        issues.append('Release has no assignment to the selected profile')
    if s.get('CODE_SIGN_STYLE') != 'Manual':
        issues.append('Release signing style must be Manual for this workflow')
    identity = s.get('CODE_SIGN_IDENTITY', '')
    hashes = {hashlib.sha1(c).hexdigest().upper() for c in p.get('DeveloperCertificates', [])}
    if not ('Distribution' in identity or identity.upper() in hashes):
        issues.append('Release identity is not a distribution identity')
    if s.get('CODE_SIGNING_ALLOWED') == 'NO':
        issues.append('Release code signing is disabled')
    if issues:
        raise ValueError('; '.join(issues))


def main():
    bundle = os.environ.get('BUNDLE_ID', '')
    if not bundle:
        raise ValueError('BUNDLE_ID is required')
    paths = sorted((ROOT / '.codemagic-signing/profiles').glob('*.mobileprovision'))
    if not paths:
        raise ValueError('No downloaded provisioning profiles. Check fetch-signing-files output, App ID, API permissions and team.')
    text = run(['security', 'find-identity', '-v', '-p', 'codesigning']).decode()
    identities = set(re.findall(r'\b[0-9A-F]{40}\b', text.upper()))
    candidates = []
    for path in paths:
        try:
            profile = plistlib.loads(run(['security', 'cms', '-D', '-i', str(path)]))
        except (subprocess.CalledProcessError, plistlib.InvalidFileException):
            print('Rejected undecodable profile: ' + path.name)
            continue
        why = rejection(profile, bundle, identities, dt.datetime.now(dt.timezone.utc),
                        os.environ.get('PUSH_ENABLED') == 'true', os.environ.get('APPLE_TEAM_ID'))
        if why:
            print('Rejected profile ' + path.name + ': ' + why)
        else:
            candidates.append((profile, path))
    if not candidates:
        raise ValueError('No usable App Store profile for ' + bundle + '. See rejection reasons; do not recreate credentials without checking them.')
    if len({tuple(p['TeamIdentifier']) for p, _ in candidates}) > 1:
        raise ValueError('Multiple Apple teams match. Set APPLE_TEAM_ID to the intended team.')
    profile, path = max(candidates, key=lambda pair: pair[0]['ExpirationDate'])
    subprocess.run(['xcode-project', 'use-profiles', '--project', PROJECT, '--profile', str(path),
                    '--archive-method', 'app-store', '--code-signing-setup-verbose-logging',
                    '--custom-export-options', '{"testFlightInternalTestingOnly": true}'], cwd=ROOT, check=True)
    data = json.loads(run(['xcodebuild', '-project', PROJECT, '-scheme', 'App', '-configuration', 'Release',
                          '-sdk', 'iphoneos', '-destination', 'generic/platform=iOS', '-showBuildSettings', '-json']))
    targets = [t['buildSettings'] for t in data if t.get('target') == 'App']
    if len(targets) != 1:
        raise ValueError('Expected one App target in effective Release settings')
    verify_settings(targets[0], profile, bundle)
    summary = {k: targets[0].get(k, '') for k in ('PRODUCT_BUNDLE_IDENTIFIER', 'DEVELOPMENT_TEAM',
               'CODE_SIGN_STYLE', 'CODE_SIGN_IDENTITY', 'PROVISIONING_PROFILE_SPECIFIER')}
    summary['profileExpires'] = profile['ExpirationDate'].isoformat()
    out = ROOT / 'build/signing-summary.json'
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(summary, indent=2) + '\n')
    print('Verified App / Release signing:\n' + json.dumps(summary, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, subprocess.CalledProcessError) as exc:
        if isinstance(exc, subprocess.CalledProcessError):
            print((exc.stderr or b'').decode(errors='replace')[-5000:], file=sys.stderr)
            message = 'Signing tool failed; inspect preceding signing output.'
        else:
            message = str(exc)
        sys.exit('Signing preflight failed: ' + message)
