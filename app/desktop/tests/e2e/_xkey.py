"""Inject a real X key chord into the running X display via XTest.

Usage: python3 -I _xkey.py <Keysym> [<Modifier-Keysym> ...]

Presses the modifiers, taps the key, releases in reverse — e.g.
`_xkey.py Next Alt_L` is Alt+PageDown. The event enters at the X server, so
it reaches Electron exactly like a physical key (unlike a CDP-dispatched
Playwright key, which never reaches native menu accelerators). Uses only
libX11/libXtst through ctypes: no xdotool dependency.
"""
import ctypes
import ctypes.util
import sys
import time

x11 = ctypes.CDLL(ctypes.util.find_library("X11") or "libX11.so.6")
xtst = ctypes.CDLL(ctypes.util.find_library("Xtst") or "libXtst.so.6")
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XStringToKeysym.restype = ctypes.c_ulong
x11.XStringToKeysym.argtypes = [ctypes.c_char_p]
x11.XKeysymToKeycode.restype = ctypes.c_ubyte
x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x11.XFlush.argtypes = [ctypes.c_void_p]
x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
xtst.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]

display = x11.XOpenDisplay(None)
if not display:
    sys.exit("cannot open X display")


def keycode(name: str) -> int:
    code = x11.XKeysymToKeycode(display, x11.XStringToKeysym(name.encode()))
    if not code:
        sys.exit(f"no keycode for {name}")
    return code


key, *modifiers = sys.argv[1:]
codes = [keycode(m) for m in modifiers] + [keycode(key)]
for code in codes:
    xtst.XTestFakeKeyEvent(display, code, 1, 0)
    x11.XFlush(display)
    time.sleep(0.03)
for code in reversed(codes):
    xtst.XTestFakeKeyEvent(display, code, 0, 0)
    x11.XFlush(display)
    time.sleep(0.03)
x11.XCloseDisplay(display)
