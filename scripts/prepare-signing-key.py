#!/usr/bin/env python3
"""Validate CERTIFICATE_PRIVATE_KEY without logging its contents."""
import os
from pathlib import Path
import subprocess
import sys

def prepare(value):
    value = (value or '').strip().lstrip('\ufeff').replace('\r\n', '\n')
    if not value:
        raise ValueError('CERTIFICATE_PRIVATE_KEY is missing or empty. Check the code_signing group.')
    if value.startswith(('ssh-rsa ', 'ssh-ed25519 ', '-----BEGIN PUBLIC KEY-----')):
        raise ValueError('A public key was supplied. Use the private file without the .pub extension.')
    if '-----BEGIN OPENSSH PRIVATE KEY-----' in value:
        raise ValueError('This is OpenSSH format. Convert the existing RSA key to PEM on your PC before saving it.')
    if 'ENCRYPTED' in value:
        raise ValueError('This workflow expects an unencrypted RSA signing key. Do not use an encrypted key here.')
    # A copy/paste can preserve literal backslash-n characters rather than actual newlines.
    if '\\n' in value and '\n' not in value:
        value = value.replace('\\r\\n', '\n').replace('\\n', '\n')
    value = value.strip()
    if not value.startswith(('-----BEGIN RSA PRIVATE KEY-----', '-----BEGIN PRIVATE KEY-----')):
        raise ValueError('Expected full PEM private-key contents, including BEGIN/END lines, not a filename, base64 wrapper or masked value.')
    result = subprocess.run(['openssl', 'rsa', '-check', '-noout', '-passin', 'pass:'],
                            input=(value + '\n').encode(), capture_output=True)
    if result.returncode:
        raise ValueError('The value cannot be parsed as an unencrypted RSA private key. Re-copy the complete original signing key; the Apple API .p8 key is a different credential.')
    return value + '\n'

def main():
    try:
        value = prepare(os.environ.get('CERTIFICATE_PRIVATE_KEY'))
    except ValueError as exc:
        sys.exit('Signing key check failed: ' + str(exc))
    directory = Path(__file__).resolve().parent.parent / '.codemagic-signing'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = directory / 'certificate-key.pem'
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as out:
        out.write(value)
    os.chmod(path, 0o600)
    print('Signing key check passed: valid unencrypted RSA private key; contents not logged.')

if __name__ == '__main__':
    main()
