package gui

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

// stubLookPath resolves the named binaries to "/usr/bin/<name>" and reports
// everything else absent.
func stubLookPath(names ...string) func(string) (string, error) {
	present := make(map[string]bool, len(names))
	for _, n := range names {
		present[n] = true
	}
	return func(name string) (string, error) {
		if present[name] {
			return "/usr/bin/" + name, nil
		}
		return "", errors.New("not found")
	}
}

func TestResolveBackend(t *testing.T) {
	defer func(saved string) { goos = saved }(goos)

	t.Run("darwin is screen-sharing", func(t *testing.T) {
		goos = "darwin"
		name, path := ResolveBackend(stubLookPath())
		if name != "screen-sharing" || path != "" {
			t.Errorf("ResolveBackend() = (%q, %q), want (screen-sharing, \"\")", name, path)
		}
	})

	t.Run("Xtigervnc first", func(t *testing.T) {
		goos = "linux"
		name, path := ResolveBackend(stubLookPath("Xtigervnc", "Xvnc"))
		if name != "Xtigervnc" || path != "/usr/bin/Xtigervnc" {
			t.Errorf("ResolveBackend() = (%q, %q), want Xtigervnc", name, path)
		}
	})

	t.Run("Xvnc fallback", func(t *testing.T) {
		goos = "linux"
		name, path := ResolveBackend(stubLookPath("Xvnc"))
		if name != "Xvnc" || path != "/usr/bin/Xvnc" {
			t.Errorf("ResolveBackend() = (%q, %q), want the Xvnc fallback", name, path)
		}
	})

	t.Run("neither resolves to empty", func(t *testing.T) {
		goos = "linux"
		name, path := ResolveBackend(stubLookPath())
		if name != "" || path != "" {
			t.Errorf("ResolveBackend() = (%q, %q), want (\"\", \"\")", name, path)
		}
	})
}

func TestBackendArgv(t *testing.T) {
	got := BackendArgv("/usr/bin/Xtigervnc", ":10", "/state/hexokit/gui/host.sock", "1600x900")
	want := []string{
		"/usr/bin/Xtigervnc", ":10",
		"-rfbunixpath", "/state/hexokit/gui/host.sock",
		"-rfbport", "-1",
		"-SecurityTypes", "None",
		"-AlwaysShared",
		"-AcceptSetDesktopSize",
		"-geometry", "1600x900",
		"-FrameRate=60",
		"-desktop", "run-kit",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("BackendArgv() = %v, want %v", got, want)
	}

	// The TCP port is pinned off in every argv — find "-rfbport" and assert
	// the following element.
	for i, arg := range got {
		if arg == "-rfbport" {
			if i+1 >= len(got) || got[i+1] != "-1" {
				t.Fatalf("-rfbport followed by %v, want -1 (nothing may listen on TCP)", got[i+1:])
			}
			return
		}
	}
	t.Fatal("-rfbport missing from BackendArgv")
}

func TestResolveWM(t *testing.T) {
	t.Run("ladder order: icewm wins over an installed openbox", func(t *testing.T) {
		argv, pinMissed, ok := ResolveWM(stubLookPath("openbox", "icewm-session"), "")
		if !ok || pinMissed || !reflect.DeepEqual(argv, []string{"icewm-session", "--nobg", "--notray"}) {
			t.Errorf("ResolveWM() = %v, %v, %v, want [icewm-session --nobg --notray], false, true", argv, pinMissed, ok)
		}
		argv, pinMissed, ok = ResolveWM(stubLookPath("kwin_x11", "i3"), "")
		if !ok || pinMissed || !reflect.DeepEqual(argv, []string{"i3"}) {
			t.Errorf("ResolveWM() = %v, %v, %v, want [i3], false, true", argv, pinMissed, ok)
		}
	})

	t.Run("pin hit wins over the ladder", func(t *testing.T) {
		argv, pinMissed, ok := ResolveWM(stubLookPath("icewm-session", "openbox"), "openbox")
		if !ok || pinMissed || !reflect.DeepEqual(argv, []string{"openbox"}) {
			t.Errorf("ResolveWM(pin=openbox) = %v, %v, %v, want [openbox], false, true", argv, pinMissed, ok)
		}
	})

	t.Run("pin miss falls back to the ladder", func(t *testing.T) {
		argv, pinMissed, ok := ResolveWM(stubLookPath("openbox"), "xfwm4")
		if !ok || !pinMissed || !reflect.DeepEqual(argv, []string{"openbox"}) {
			t.Errorf("ResolveWM(pin=xfwm4) = %v, %v, %v, want [openbox], true, true", argv, pinMissed, ok)
		}
	})

	t.Run("pin miss with an empty ladder resolves nothing", func(t *testing.T) {
		argv, pinMissed, ok := ResolveWM(stubLookPath(), "xfwm4")
		if ok || !pinMissed || argv != nil {
			t.Errorf("ResolveWM(pin=xfwm4) = %v, %v, %v, want nil, true, false", argv, pinMissed, ok)
		}
	})

	t.Run("x-session-manager wraps in dbus-run-session on both paths", func(t *testing.T) {
		want := []string{"dbus-run-session", "--", "x-session-manager"}
		if argv, _, ok := ResolveWM(stubLookPath("x-session-manager"), ""); !ok || !reflect.DeepEqual(argv, want) {
			t.Errorf("ResolveWM(ladder) = %v, %v, want %v, true", argv, ok, want)
		}
		if argv, pinMissed, ok := ResolveWM(stubLookPath("x-session-manager"), "x-session-manager"); !ok || pinMissed || !reflect.DeepEqual(argv, want) {
			t.Errorf("ResolveWM(pin) = %v, %v, %v, want %v, false, true", argv, pinMissed, ok, want)
		}
	})

	t.Run("icewm flags on both paths", func(t *testing.T) {
		want := []string{"icewm-session", "--nobg", "--notray"}
		if argv, _, ok := ResolveWM(stubLookPath("icewm-session"), ""); !ok || !reflect.DeepEqual(argv, want) {
			t.Errorf("ResolveWM(ladder) = %v, %v, want %v, true", argv, ok, want)
		}
		if argv, pinMissed, ok := ResolveWM(stubLookPath("icewm-session"), "icewm-session"); !ok || pinMissed || !reflect.DeepEqual(argv, want) {
			t.Errorf("ResolveWM(pin) = %v, %v, %v, want %v, false, true", argv, pinMissed, ok, want)
		}
	})

	t.Run("none found", func(t *testing.T) {
		if argv, pinMissed, ok := ResolveWM(stubLookPath(), ""); ok || pinMissed || argv != nil {
			t.Errorf("ResolveWM() = %v, %v, %v, want nil, false, false", argv, pinMissed, ok)
		}
	})
}

func TestWMArgv(t *testing.T) {
	for name, want := range map[string][]string{
		"icewm-session":     {"icewm-session", "--nobg", "--notray"},
		"openbox":           {"openbox"},
		"xfwm4":             {"xfwm4"},
		"startlxqt":         {"dbus-run-session", "--", "startlxqt"},
		"lxqt-session":      {"dbus-run-session", "--", "lxqt-session"},
		"startxfce4":        {"dbus-run-session", "--", "startxfce4"},
		"xfce4-session":     {"dbus-run-session", "--", "xfce4-session"},
		"startplasma-x11":   {"dbus-run-session", "--", "startplasma-x11"},
		"startlxde":         {"dbus-run-session", "--", "startlxde"},
		"mate-session":      {"dbus-run-session", "--", "mate-session"},
		"cinnamon-session":  {"dbus-run-session", "--", "cinnamon-session"},
		"x-session-manager": {"dbus-run-session", "--", "x-session-manager"},
	} {
		if got := WMArgv(name); !reflect.DeepEqual(got, want) {
			t.Errorf("WMArgv(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestWMName(t *testing.T) {
	for argv, want := range map[string]string{
		"dbus-run-session -- startlxqt":       "startlxqt",
		"dbus-run-session -- startxfce4":      "startxfce4",
		"icewm-session --nobg --notray":       "icewm-session",
		"openbox":                             "openbox",
		"dbus-run-session":                    "dbus-run-session",
		"dbus-run-session startlxqt":          "dbus-run-session",
		"dbus-run-session -- startlxqt extra": "dbus-run-session",
	} {
		got := WMName(strings.Fields(argv))
		if got != want {
			t.Errorf("WMName(%q) = %q, want %q", argv, got, want)
		}
	}
}

func TestIsSessionStarter(t *testing.T) {
	for _, name := range []string{
		"startlxqt", "lxqt-session", "startxfce4", "xfce4-session",
		"startplasma-x11", "startlxde", "mate-session", "cinnamon-session", "x-session-manager",
	} {
		if !IsSessionStarter(name) {
			t.Errorf("IsSessionStarter(%q) = false, want true", name)
		}
	}
	for _, name := range []string{"openbox", "icewm-session", "xfwm4", ""} {
		if IsSessionStarter(name) {
			t.Errorf("IsSessionStarter(%q) = true, want false", name)
		}
	}
}

func TestIsLXQt(t *testing.T) {
	for _, name := range []string{"startlxqt", "lxqt-session"} {
		if !IsLXQt(name) {
			t.Errorf("IsLXQt(%q) = false, want true", name)
		}
	}
	for _, name := range []string{"icewm-session", "openbox", "startxfce4", "xfce4-session", "startplasma-x11", "x-session-manager", ""} {
		if IsLXQt(name) {
			t.Errorf("IsLXQt(%q) = true, want false", name)
		}
	}
}

func TestWMOwnsProcessGroup(t *testing.T) {
	for argv, want := range map[string]bool{
		"dbus-run-session -- startlxqt":      true,
		"dbus-run-session -- xfce4-session":  true,
		"icewm-session --nobg --notray":      false,
		"openbox":                            false,
		"dbus-run-session -- openbox":        false,
		"dbus-run-session -- startlxqt bad4": false,
	} {
		if got := WMOwnsProcessGroup(strings.Fields(argv)); got != want {
			t.Errorf("WMOwnsProcessGroup(%q) = %v, want %v", argv, got, want)
		}
	}
}

func TestWMLadderOrder(t *testing.T) {
	want := []string{"icewm-session", "openbox", "xfwm4", "i3", "kwin_x11", "x-session-manager"}
	if got := WMLadder(); !reflect.DeepEqual(got, want) {
		t.Errorf("WMLadder() = %v, want %v", got, want)
	}
	// The accessor must return a copy: mutating it must not poison the ladder.
	WMLadder()[0] = "mutated"
	if got := WMLadder(); !reflect.DeepEqual(got, want) {
		t.Errorf("WMLadder() after mutation = %v, want %v", got, want)
	}
}

func TestRootBackgroundArgv(t *testing.T) {
	t.Run("xsetroot present", func(t *testing.T) {
		argv, ok := RootBackgroundArgv(stubLookPath("xsetroot"))
		if !ok || !reflect.DeepEqual(argv, []string{"xsetroot", "-solid", RootBackground}) {
			t.Errorf("RootBackgroundArgv() = %v, %v, want [xsetroot -solid %s], true", argv, ok, RootBackground)
		}
	})

	t.Run("xsetroot absent", func(t *testing.T) {
		if argv, ok := RootBackgroundArgv(stubLookPath("openbox")); ok || argv != nil {
			t.Errorf("RootBackgroundArgv() = %v, %v, want nil, false", argv, ok)
		}
	})
}
