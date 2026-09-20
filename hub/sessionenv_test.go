package main

import (
	"errors"
	"strings"
	"testing"
)

func envValue(env []string, key string) (string, int) {
	val, n := "", 0
	for _, kv := range env {
		k, v, _ := strings.Cut(kv, "=")
		if k == key {
			val, n = v, n+1
		}
	}
	return val, n
}

func TestHasDisplay(t *testing.T) {
	if hasDisplay([]string{"DISPLAY=", "WAYLAND_DISPLAY="}) {
		t.Fatal("空串应算作没有显示环境")
	}
	if !hasDisplay([]string{"DISPLAY=:1"}) {
		t.Fatal("DISPLAY=:1 应算有")
	}
	if !hasDisplay([]string{"WAYLAND_DISPLAY=wayland-0"}) {
		t.Fatal("WAYLAND_DISPLAY 应算有")
	}
	if hasDisplay([]string{"PATH=/usr/bin"}) {
		t.Fatal("只有 PATH 时不该算有")
	}
}

func TestMergeSessionEnvReplacesInPlace(t *testing.T) {
	env := []string{"PATH=/usr/bin", "DISPLAY=", "LANG=zh_CN.UTF-8"}
	out := mergeSessionEnv(env, "DISPLAY=:1\nWAYLAND_DISPLAY=wayland-0\n", sessionVars)

	if v, n := envValue(out, "DISPLAY"); v != ":1" || n != 1 {
		t.Fatalf("DISPLAY=%q 出现 %d 次", v, n)
	}
	if v, n := envValue(out, "WAYLAND_DISPLAY"); v != "wayland-0" || n != 1 {
		t.Fatalf("WAYLAND_DISPLAY=%q 出现 %d 次", v, n)
	}
	if v, n := envValue(out, "PATH"); v != "/usr/bin" || n != 1 {
		t.Fatalf("PATH 被动了：%q 出现 %d 次", v, n)
	}
	if v, _ := envValue(out, "LANG"); v != "zh_CN.UTF-8" {
		t.Fatalf("LANG 丢了：%q", v)
	}
}

func TestMergeSessionEnvIgnoresOutsideAllowlist(t *testing.T) {
	out := mergeSessionEnv([]string{"PATH=/usr/bin"}, "PATH=/会话/bin\nGTK_MODULES=appmenu\n", sessionVars)
	if v, _ := envValue(out, "PATH"); v != "/usr/bin" {
		t.Fatalf("白名单外的 PATH 不该被覆盖：%q", v)
	}
	if _, n := envValue(out, "GTK_MODULES"); n != 0 {
		t.Fatal("白名单外的键不该被追加")
	}
}

func TestMergeSessionEnvSkipsEmptyAndCRLF(t *testing.T) {
	out := mergeSessionEnv(nil, "DISPLAY=\nXAUTHORITY=/home/u/.Xauthority\r\n\nWAYLAND_DISPLAY=wayland-0\n", sessionVars)
	if _, n := envValue(out, "DISPLAY"); n != 0 {
		t.Fatal("会话环境里为空的键不该追加")
	}
	if v, _ := envValue(out, "XAUTHORITY"); v != "/home/u/.Xauthority" {
		t.Fatalf("CRLF 没剥干净：%q", v)
	}
	if v, _ := envValue(out, "WAYLAND_DISPLAY"); v != "wayland-0" {
		t.Fatalf("WAYLAND_DISPLAY=%q", v)
	}
}

func TestMergeSessionEnvNoDuplicateKeys(t *testing.T) {
	out := mergeSessionEnv([]string{"DISPLAY=", "DISPLAY="}, "DISPLAY=:1\n", sessionVars)
	if v, n := envValue(out, "DISPLAY"); v != ":1" || n != 2 {
		t.Fatalf("重复键应逐条替换，不留空值：%q 出现 %d 次", v, n)
	}
	for _, kv := range out {
		if strings.HasSuffix(kv, "=") {
			t.Fatalf("残留空值条目：%q", kv)
		}
	}
}

func TestGuiEnvBackfillsDisplay(t *testing.T) {
	t.Setenv("DISPLAY", "")
	t.Setenv("WAYLAND_DISPLAY", "")
	restore := showEnvironment
	t.Cleanup(func() { showEnvironment = restore })
	showEnvironment = func() (string, error) {
		return "DISPLAY=:1\nWAYLAND_DISPLAY=wayland-0\nPATH=/usr/bin\n", nil
	}

	if v, _ := envValue(guiEnv(), "DISPLAY"); v != ":1" {
		t.Fatalf("DISPLAY 没补上：%q", v)
	}
	if v, _ := envValue(guiEnv(), "WAYLAND_DISPLAY"); v != "wayland-0" {
		t.Fatalf("WAYLAND_DISPLAY 没补上：%q", v)
	}
}

func TestGuiEnvSkipsQueryWhenDisplayPresent(t *testing.T) {
	t.Setenv("DISPLAY", ":1")
	restore := showEnvironment
	t.Cleanup(func() { showEnvironment = restore })
	called := false
	showEnvironment = func() (string, error) {
		called = true
		return "DISPLAY=:99", nil
	}

	if v, _ := envValue(guiEnv(), "DISPLAY"); v != ":1" {
		t.Fatalf("有显示环境时不该改：%q", v)
	}
	if called {
		t.Fatal("有显示环境时不该去问 systemd")
	}
}

func TestGuiEnvKeepsEnvWhenQueryFails(t *testing.T) {
	t.Setenv("DISPLAY", "")
	t.Setenv("WAYLAND_DISPLAY", "")
	t.Setenv("PI_HUB_TEST_MARK", "keep")
	restore := showEnvironment
	t.Cleanup(func() { showEnvironment = restore })
	showEnvironment = func() (string, error) { return "", errors.New("systemctl 不在") }

	out := guiEnv()
	if v, _ := envValue(out, "PI_HUB_TEST_MARK"); v != "keep" {
		t.Fatal("查不到会话环境时应保持原环境")
	}
	if v, _ := envValue(out, "DISPLAY"); v != "" {
		t.Fatalf("不该凭空造出 DISPLAY：%q", v)
	}
}
