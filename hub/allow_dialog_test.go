package main

import "testing"

func TestPickGrantCode(t *testing.T) {
	pastedWins := pickGrantCode("  PIHUB-deadbeefdeadbeef  ", "im / 客  · PIHUB-cafebabecafebabe")
	if pastedWins != "PIHUB-deadbeefdeadbeef" {
		t.Fatalf("pasted: %q", pastedWins)
	}
	fromCombo := pickGrantCode("PIHUB-", "im / 客  · PIHUB-cafebabecafebabe")
	if fromCombo != "PIHUB-cafebabecafebabe" {
		t.Fatalf("combo: %q", fromCombo)
	}
	empty := pickGrantCode("PIHUB-", "（无待授权账号）")
	if empty != "" {
		t.Fatalf("empty: %q", empty)
	}
}

func TestParseYadForm(t *testing.T) {
	pasted, selected := parseYadForm("121313221|im / 客  · PIHUB-cafebabecafebabe|audit  sudo ls|\n")
	if pasted != "121313221" || selected != "im / 客  · PIHUB-cafebabecafebabe" {
		t.Fatalf("%q %q", pasted, selected)
	}
}

func TestComboValues(t *testing.T) {
	got := comboValues([]PairItem{
		{Code: "PIHUB-aa", Channel: "im", UserID: "u1", DisplayName: "林"},
		{Code: "PIHUB-bb", Channel: "im", UserID: "u2"},
	})
	want := "im / 林  · PIHUB-aa!im / u2  · PIHUB-bb"
	if got != want {
		t.Fatalf("%q", got)
	}
}
