package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestSettledCardHasNoButtons(t *testing.T) {
	raw := settledCard("allow", "decided", "adapter")
	if strings.Contains(raw, "button") || strings.Contains(raw, "column_set") {
		t.Fatalf("决断后的卡不该还留着按钮：%s", raw)
	}
	var card map[string]any
	if err := json.Unmarshal([]byte(raw), &card); err != nil {
		t.Fatalf("卡不是合法 JSON：%v", err)
	}
	if card["schema"] != "2.0" {
		t.Fatalf("schema 应该是 2.0（改卡走 messages patch），实际 %v", card["schema"])
	}
	if !strings.Contains(raw, "已决断") || !strings.Contains(raw, "allow") {
		t.Fatalf("缺决断标记：%s", raw)
	}
}

func TestSettledTitle(t *testing.T) {
	cases := map[string]string{
		"allow": "已决断 · 允许",
		"deny":  "已决断 · 拒绝",
		"":      "已决断 · ",
	}
	for action, want := range cases {
		if got := settledTitle(action); got != want {
			t.Fatalf("%q: got %q want %q", action, got, want)
		}
	}
}
