package main

import (
	"bytes"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
)

var pairingCodeRe = regexp.MustCompile(`PIHUB-[0-9a-fA-F]+`)

func findYad() string {
	p, err := exec.LookPath("yad")
	if err != nil {
		return ""
	}
	return p
}

func pairComboLabel(p PairItem) string {
	name := strings.TrimSpace(p.DisplayName)
	if name == "" {
		name = p.UserID
	}
	return fmt.Sprintf("%s / %s  · %s", p.Channel, name, p.Code)
}

func comboValues(pairs []PairItem) string {
	if len(pairs) == 0 {
		return "（无待授权账号）"
	}
	parts := make([]string, 0, len(pairs))
	for _, p := range pairs {
		parts = append(parts, pairComboLabel(p))
	}
	return strings.Join(parts, "!")
}

func asksText(asks []ListItem) string {
	if len(asks) == 0 {
		return "没有未决审批"
	}
	lines := make([]string, 0, len(asks))
	for _, a := range asks {
		cmd := a.Command
		if cmd == "" {
			cmd = a.RequestID
		}
		lines = append(lines, fmt.Sprintf("%s  %s  至 %s", a.Kind, cmd, a.ExpiresAt))
	}
	return strings.Join(lines, "\n")
}

func parseYadForm(stdout string) (pasted, selected string) {
	line := strings.TrimRight(stdout, "\n")
	parts := strings.Split(line, "|")
	if len(parts) > 0 {
		pasted = parts[0]
	}
	if len(parts) > 1 {
		selected = parts[1]
	}
	return pasted, selected
}

func pickGrantCode(pasted, selected string) string {
	pasted = strings.TrimSpace(pasted)
	if strings.HasPrefix(pasted, pairingPrefix) && len(pasted) > len(pairingPrefix) {
		return pasted
	}
	if m := pairingCodeRe.FindString(selected); m != "" {
		return m
	}
	return ""
}

func runAllowDialog(yad string, pairs []PairItem, asks []ListItem) (string, error) {
	if yad == "" {
		return "", fmt.Errorf("未找到 yad")
	}
	cmd := exec.Command(yad,
		"--title=IM 许可 · pi-hub",
		"--text=只在本机授权。把配对码贴进来，或从待授权列表选一条。\n未决审批只展示，点授权才交给 hub。",
		"--form",
		"--field=配对码:CE",
		"--field=待授权账号:CB",
		"PIHUB-",
		comboValues(pairs),
		"--field=未决审批:TXT",
		asksText(asks),
		"--button=关闭:1",
		"--button=授权:0",
	)
	var stdout bytes.Buffer
	cmd.Env = guiEnv()
	cmd.Stdout = &stdout
	cmd.Stderr = nil
	err := cmd.Run()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok && ee.ExitCode() != 0 {
			return "", nil
		}
		return "", err
	}
	pasted, selected := parseYadForm(stdout.String())
	return pickGrantCode(pasted, selected), nil
}
