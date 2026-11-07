#!/usr/bin/python3
"""Prints the directory name Paseo uses under <worktrees root> for a repository's worktrees.

Mirrors deriveWorktreeProjectHash in the Paseo daemon: the first 8 bytes of SHA-256 over the repository root's real
path, as a big-endian integer in base 36, zero-padded to 13 digits and cut to 8. If Paseo changes this derivation,
the sandbox denies the new worktree directory (agents cannot write their checkout) rather than allowing a wider one.
"""
import hashlib
import os
import sys

DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz"


def project_hash(repo_root: str) -> str:
    value = int.from_bytes(hashlib.sha256(repo_root.encode("utf-8")).digest()[:8], "big")
    encoded = ""
    while value:
        value, remainder = divmod(value, 36)
        encoded = DIGITS[remainder] + encoded
    return encoded.rjust(13, "0")[:8]


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: paseo-project-hash.py <repository root>")
    print(project_hash(os.path.realpath(sys.argv[1])))
