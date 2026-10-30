import importlib.util
from pathlib import Path
import subprocess
import unittest

spec = importlib.util.spec_from_file_location('keycheck', Path(__file__).resolve().parents[1] / 'scripts/prepare-signing-key.py')
keycheck = importlib.util.module_from_spec(spec)
spec.loader.exec_module(keycheck)

class SigningKeyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.key = subprocess.run(['openssl', 'genrsa', '2048'], capture_output=True, check=True).stdout.decode()

    def test_valid_key_and_crlf(self):
        self.assertEqual(keycheck.prepare(self.key.replace('\n', '\r\n')), self.key)

    def test_literal_newlines(self):
        self.assertEqual(keycheck.prepare(self.key.replace('\n', '\\n')), self.key)

    def test_missing_public_openssh_and_masked_values(self):
        for value in ('', 'ssh-rsa AAAA', '-----BEGIN PUBLIC KEY-----',
                      '-----BEGIN OPENSSH PRIVATE KEY-----', '********', 'C:\\key.pem'):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):keycheck.prepare(value)

    def test_malformed_and_encrypted_keys(self):
        for value in ('-----BEGIN RSA PRIVATE KEY-----\ninvalid\n-----END RSA PRIVATE KEY-----',
                      '-----BEGIN ENCRYPTED PRIVATE KEY-----'):
            with self.assertRaises(ValueError):keycheck.prepare(value)

    def test_api_ec_key_is_not_a_signing_rsa_key(self):
        ec = subprocess.run(['openssl', 'genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256'], capture_output=True, check=True).stdout.decode()
        with self.assertRaises(ValueError):keycheck.prepare(ec)
