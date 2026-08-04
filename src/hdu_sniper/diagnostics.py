"""Non-interactive checks used to validate packaged desktop releases."""

from __future__ import annotations

from hdu_sniper.library.login import _aes_ecb_encrypt_base64


def desktop_self_check() -> int:
    """Verify the crypto/login runtime required by HTTP login is importable."""
    try:
        _aes_ecb_encrypt_base64("AAAAAAAAAAAAAAAAAAAAAA==", "self-check")
    except Exception:
        return 11
    return 0
