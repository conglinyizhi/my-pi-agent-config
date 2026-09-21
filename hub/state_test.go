package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDecideFirstWins(t *testing.T) {
	h := newHub("", time.Hour, 15*time.Minute, nil)
	ask := h.SubmitAsk("req-1", "sess", "audit", map[string]any{"command": "sudo ls"}, 0)
	env, err := h.Decide("req-1", byGUI, nil, "allow", "ok", nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if env.Action != "allow" || env.Reason != settleDecided {
		t.Fatalf("got %+v", env)
	}
	pair, _, err := h.Pair("x", "1", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.Grant(pair.Code); err != nil {
		t.Fatal(err)
	}
	_, err = h.Decide("req-1", byAdapter, &Principal{Channel: "x", UserID: "1"}, "deny", "", nil, nil, nil)
	if err != errUnknownAsk && err != errAlreadySettled {
		t.Fatalf("second decide: %v", err)
	}
	got := h.wait(ask)
	if got.Action != "allow" {
		t.Fatalf("waiter got %+v", got)
	}
}

func TestAdapterNeedsAllowlist(t *testing.T) {
	h := newHub("", time.Hour, 15*time.Minute, nil)
	h.SubmitAsk("req-2", "sess", "audit", map[string]any{"command": "rm"}, 0)
	_, err := h.Decide("req-2", byAdapter, &Principal{Channel: "im", UserID: "u1"}, "allow", "", nil, nil, nil)
	if err != errUnauthorized {
		t.Fatalf("want unauthorized, got %v", err)
	}
}

func TestPairAndGrant(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "allowlist.json")
	h := newHub(path, time.Hour, 15*time.Minute, nil)
	pair, allowed, err := h.Pair("im", "u1", "林")
	if err != nil || allowed || pair == nil {
		t.Fatalf("pair: allowed=%v err=%v pair=%v", allowed, err, pair)
	}
	if pair.Code[:6] != pairingPrefix {
		t.Fatalf("code %q", pair.Code)
	}
	old := pair.Code
	pair2, _, err := h.Pair("im", "u1", "林")
	if err != nil {
		t.Fatal(err)
	}
	if pair2.Code == old {
		t.Fatal("refresh should rotate code")
	}
	listed := h.ListPairs()
	if len(listed) != 1 || listed[0].Code != pair2.Code || listed[0].UserID != "u1" {
		t.Fatalf("pairs %+v", listed)
	}
	_, err = h.Grant(old)
	if err != errUnknownCode {
		t.Fatalf("old code should die, got %v", err)
	}
	p, err := h.Grant(pair2.Code)
	if err != nil || p.UserID != "u1" {
		t.Fatalf("grant: %+v %v", p, err)
	}
	_, allowed, err = h.Pair("im", "u1", "林")
	if err != nil || !allowed {
		t.Fatalf("after grant should be allowed, err=%v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil || len(data) == 0 {
		t.Fatalf("persist: %v", err)
	}
}

func TestExpiredPair(t *testing.T) {
	now := time.Date(2026, 4, 8, 12, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	h := newHub("", time.Hour, 15*time.Minute, clock)
	pair, _, err := h.Pair("im", "u2", "")
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(16 * time.Minute)
	h.SweepExpiredPairs()
	_, err = h.Grant(pair.Code)
	if err != errUnknownCode {
		t.Fatalf("want expired, got %v", err)
	}
}

func TestListSkipsExpired(t *testing.T) {
	now := time.Date(2026, 4, 8, 12, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	h := newHub("", time.Hour, 15*time.Minute, clock)
	h.SubmitAsk("live", "s", "audit", map[string]any{"command": "echo"}, time.Hour)
	h.SubmitAsk("dead", "s", "audit", map[string]any{"command": "rm"}, time.Minute)
	now = now.Add(2 * time.Minute)
	items := h.List()
	if len(items) != 1 || items[0].RequestID != "live" {
		t.Fatalf("items=%+v", items)
	}
}

func TestExpireSettles(t *testing.T) {
	now := time.Date(2026, 4, 8, 12, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	h := newHub("", time.Hour, 15*time.Minute, clock)
	ask := h.SubmitAsk("req-e", "s", "audit", nil, time.Minute)
	now = now.Add(2 * time.Minute)
	env, err := h.Expire("req-e")
	if err != nil || env.Reason != settleExpired || env.Action != "deny" {
		t.Fatalf("%+v %v", env, err)
	}
	got := h.wait(ask)
	if got.Reason != settleExpired {
		t.Fatalf("%+v", got)
	}
}

func TestPrincipalsSnapshot(t *testing.T) {
	h := newHub("", time.Hour, 15*time.Minute, nil)
	pair, _, err := h.Pair("feishu", "ou_1", "丛林")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.Grant(pair.Code); err != nil {
		t.Fatal(err)
	}
	got := h.Principals()
	if len(got) != 1 || got[0].Channel != "feishu" || got[0].UserID != "ou_1" {
		t.Fatalf("principals %+v", got)
	}
	// 快照要能随便改，不许反手写回白名单
	got[0].UserID = "改坏了"
	if again := h.Principals(); len(again) != 1 || again[0].UserID != "ou_1" {
		t.Fatalf("快照不是副本：%+v", again)
	}
}
