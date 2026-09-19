package main

import "testing"

func TestParseCardValue(t *testing.T) {
	a, id := parseCardValue(`{"action":"allow","requestId":"ask-1"}`)
	if a != "allow" || id != "ask-1" {
		t.Fatalf("%s %s", a, id)
	}
	a, id = parseCardValue("nope")
	if a != "" || id != "" {
		t.Fatalf("junk %s %s", a, id)
	}
}

func TestParseTextCommand(t *testing.T) {
	c := parseTextCommand("/list")
	if c.Kind != "list" {
		t.Fatalf("%+v", c)
	}
	c = parseTextCommand("allow ask-9 先过命令")
	if c.Kind != "allow" || c.RequestID != "ask-9" || c.Comment != "先过命令" {
		t.Fatalf("%+v", c)
	}
	c = parseTextCommand("hello")
	if c.Kind != "other" {
		t.Fatalf("%+v", c)
	}
}

func TestPickGrantFromCard(t *testing.T) {
	card := approvalCard("ask-1", "audit", "sudo ls", "sess", "t")
	if card == "" || !containsAll(card, "ask-1", "sudo ls", "schema") {
		t.Fatalf("card %s", card)
	}
}

func containsAll(s string, parts ...string) bool {
	for _, p := range parts {
		if !contains(s, p) {
			return false
		}
	}
	return true
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(sub) == 0 || indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
