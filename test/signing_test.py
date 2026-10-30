import copy
import datetime as dt
import hashlib
import importlib.util
from pathlib import Path
import unittest
import tempfile
import stat

spec = importlib.util.spec_from_file_location('signing', Path(__file__).resolve().parents[1] / 'scripts/prepare-ios-signing.py')
signing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(signing)


class SigningTests(unittest.TestCase):
    def setUp(self):
        self.now = dt.datetime(2026, 10, 30, tzinfo=dt.timezone.utc)
        self.bundle = 'com.atarah.agenthq'
        self.cert = b'synthetic certificate fixture'
        self.ids = {hashlib.sha1(self.cert).hexdigest().upper()}
        self.p = {'Name': 'App Store Agent HQ', 'UUID': 'fixture-uuid', 'TeamIdentifier': ['TEAM123'],
                  'ApplicationIdentifierPrefix': ['LEGACYPREFIX'], 'DeveloperCertificates': [self.cert],
                  'ExpirationDate': dt.datetime(2027, 1, 1),
                  'Entitlements': {'application-identifier': 'LEGACYPREFIX.' + self.bundle, 'get-task-allow': False}}
        self.s = {'PRODUCT_BUNDLE_IDENTIFIER': self.bundle, 'DEVELOPMENT_TEAM': 'TEAM123',
                  'PROVISIONING_PROFILE_SPECIFIER': self.p['Name'], 'CODE_SIGN_STYLE': 'Manual',
                  'CODE_SIGN_IDENTITY': 'Apple Distribution'}

    def reason(self, **kw):
        return signing.rejection(self.p, self.bundle, self.ids, self.now, **kw)

    def test_valid_app_store_profile_with_legacy_prefix(self):
        self.assertIsNone(self.reason())
        signing.verify_settings(self.s, self.p, self.bundle)

    def test_profile_rejection_cases(self):
        original = copy.deepcopy(self.p)
        for label, mutate, phrase in [
            ('bundle', lambda p: p['Entitlements'].update({'application-identifier': 'LEGACYPREFIX.other'}), 'bundle'),
            ('expiry', lambda p: p.update(ExpirationDate=dt.datetime(2025, 1, 1)), 'expired'),
            ('development', lambda p: p['Entitlements'].update({'get-task-allow': True}), 'App Store'),
            ('ad hoc', lambda p: p.update(ProvisionedDevices=['device']), 'App Store'),
            ('enterprise', lambda p: p.update(ProvisionsAllDevices=True), 'App Store'),
            ('certificate', lambda p: p.update(DeveloperCertificates=[b'other']), 'private key'),
        ]:
            with self.subTest(label=label):
                self.p = copy.deepcopy(original)
                mutate(self.p)
                self.assertIn(phrase, self.reason())

    def test_push_and_team_requirements(self):
        self.assertIn('push', self.reason(push=True))
        self.assertIn('team', self.reason(team='OTHER'))

    def test_effective_settings_detect_missing_or_overridden_assignment(self):
        for key, value in [('PROVISIONING_PROFILE_SPECIFIER', ''), ('DEVELOPMENT_TEAM', 'OTHER'),
                           ('PRODUCT_BUNDLE_IDENTIFIER', 'other.app'), ('CODE_SIGN_STYLE', 'Automatic'),
                           ('CODE_SIGN_IDENTITY', 'iPhone Developer'), ('CODE_SIGNING_ALLOWED', 'NO')]:
            with self.subTest(key=key):
                settings = {**self.s, key: value}
                with self.assertRaises(ValueError):
                    signing.verify_settings(settings, self.p, self.bundle)

    def test_certificate_fingerprint_identity(self):
        signing.verify_settings({**self.s, 'CODE_SIGN_IDENTITY': next(iter(self.ids))}, self.p, self.bundle)


    def test_install_profile_in_xcode_directories_by_uuid(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / 'home'
            source = Path(tmp) / 'download.mobileprovision'
            source.write_bytes(b'synthetic signed profile bytes')
            paths = signing.install_profile(source, 'fixture-uuid', home)
            self.assertEqual(paths, [
                home / 'Library/Developer/Xcode/UserData/Provisioning Profiles/fixture-uuid.mobileprovision',
                home / 'Library/MobileDevice/Provisioning Profiles/fixture-uuid.mobileprovision',
            ])
            for path in paths:
                self.assertEqual(path.read_bytes(), source.read_bytes())
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            # Reinstalling an updated download must replace its installed bytes.
            source.write_bytes(b'updated fixture')
            signing.install_profile(source, 'fixture-uuid', home)
            self.assertTrue(all(p.read_bytes() == source.read_bytes() for p in paths))

    def test_profile_install_rejects_path_traversal(self):
        with self.assertRaises(ValueError):
            signing.install_profile('unused', '../../outside')

    def test_installation_failure_stops_signing(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / 'source'
            source.write_bytes(b'fixture')
            home = Path(tmp) / 'not-a-directory'
            home.write_text('blocked')
            with self.assertRaises(OSError):
                signing.install_profile(source, 'fixture-uuid', home)


if __name__ == '__main__':
    unittest.main()
