"""Atomic same-filesystem rename, refusing an existing destination."""
import ctypes
import os
import sys

if __name__ == '__main__':
    libc = ctypes.CDLL(None, use_errno=True)
    rename = libc.renameat2
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(sys.argv[1]), -100, os.fsencode(sys.argv[2]), 1):
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
