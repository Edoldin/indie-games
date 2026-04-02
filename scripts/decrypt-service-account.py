#!/usr/bin/env python3
"""
Decrypt the Firebase service account key.

Usage:
    python scripts/decrypt-service-account.py

You will be prompted for the password.
The decrypted key is written next to the .enc file (same filename without .enc).

Requirements:
    pip install cryptography
"""

import base64
import getpass
import json
import sys
from pathlib import Path

try:
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.exceptions import InvalidTag
except ImportError:
    print("ERROR: cryptography package not found. Run: pip install cryptography")
    sys.exit(1)

ENC_FILE = Path(__file__).parent.parent / "indie-games-fdf3b-firebase-adminsdk-fbsvc-5925adb236.json.enc"
OUT_FILE = ENC_FILE.with_suffix("")  # strips the .enc suffix

def decrypt(password: bytes, payload: dict) -> bytes:
    salt  = base64.b64decode(payload["salt"])
    nonce = base64.b64decode(payload["nonce"])
    ct    = base64.b64decode(payload["ciphertext"])
    iters = payload.get("iterations", 600_000)

    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=iters)
    key = kdf.derive(password)
    return AESGCM(key).decrypt(nonce, ct, None)

def main() -> None:
    if not ENC_FILE.exists():
        print(f"ERROR: {ENC_FILE} not found.")
        sys.exit(1)

    payload  = json.loads(ENC_FILE.read_text())
    password = getpass.getpass("Password: ").encode()

    try:
        plaintext = decrypt(password, payload)
    except InvalidTag:
        print("ERROR: Wrong password or corrupted file.")
        sys.exit(1)

    OUT_FILE.write_bytes(plaintext)
    print(f"Decrypted -> {OUT_FILE}")

if __name__ == "__main__":
    main()
