package main

import (
	"encoding/json"
	"net"
	"path/filepath"
	"testing"
	"time"
)

func TestServerAskDecide(t *testing.T) {
	dir := t.TempDir()
	sock := filepath.Join(dir, "hub.sock")
	h := newHub("", time.Hour, 15*time.Minute, nil)
	s := newServer(h, sock)
	s.skipPeer = true
	if err := s.Listen(); err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	go s.Serve()

	pi := dial(t, sock)
	defer pi.Close()
	mustSend(t, pi, Envelope{V: 1, Type: typeHello, Role: rolePI})
	hello := mustRecv(t, pi)
	if hello.Type != typeHelloOK {
		t.Fatalf("hello %s", hello.Type)
	}

	adapter := dial(t, sock)
	defer adapter.Close()
	mustSend(t, adapter, Envelope{V: 1, Type: typeHello, Role: roleAdapter})
	mustRecv(t, adapter)

	mustSend(t, pi, Envelope{
		V: 1, Type: typeAsk, Kind: "audit", RequestID: "req-sock",
		SessionID: "sess", Payload: map[string]any{"command": "sudo ls"},
		TimeoutMs: 60_000,
	})
	askOK := mustRecv(t, pi)
	if askOK.Type != typeAskOK || askOK.RequestID != "req-sock" {
		t.Fatalf("ask-ok %+v", askOK)
	}
	ev := mustRecv(t, adapter)
	if ev.Type != typeEvent || ev.RequestID != "req-sock" {
		t.Fatalf("event %+v", ev)
	}

	_, _, err := h.Pair("im", "u1", "林")
	if err != nil {
		t.Fatal(err)
	}
	// 未授权 decide 应失败
	mustSend(t, adapter, Envelope{
		V: 1, Type: typeDecide, RequestID: "req-sock", Action: "allow",
		Principal: &Principal{Channel: "im", UserID: "u1"},
	})
	errEnv := mustRecv(t, adapter)
	if errEnv.Type != typeError {
		t.Fatalf("want error, got %+v", errEnv)
	}

	admin := dial(t, sock)
	defer admin.Close()
	mustSend(t, admin, Envelope{V: 1, Type: typeHello, Role: roleAdmin})
	mustRecv(t, admin)
	pair, _, _ := h.Pair("im", "u1", "林")
	mustSend(t, admin, Envelope{V: 1, Type: typeGrant, Code: pair.Code})
	grantOK := mustRecv(t, admin)
	if grantOK.Type != typeGrantOK {
		t.Fatalf("grant %+v", grantOK)
	}

	mustSend(t, adapter, Envelope{
		V: 1, Type: typeDecide, RequestID: "req-sock", Action: "allow", Comment: "行",
		Principal: &Principal{Channel: "im", UserID: "u1"},
	})
	settled := mustRecv(t, pi)
	if settled.Type != typeSettled || settled.Action != "allow" || settled.Comment != "行" {
		t.Fatalf("settled %+v", settled)
	}
}

func TestPairUnauthorizedMessage(t *testing.T) {
	dir := t.TempDir()
	sock := filepath.Join(dir, "hub.sock")
	h := newHub("", time.Hour, 15*time.Minute, nil)
	s := newServer(h, sock)
	s.skipPeer = true
	if err := s.Listen(); err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	go s.Serve()

	adapter := dial(t, sock)
	defer adapter.Close()
	mustSend(t, adapter, Envelope{V: 1, Type: typeHello, Role: roleAdapter})
	mustRecv(t, adapter)
	mustSend(t, adapter, Envelope{V: 1, Type: typePair, Channel: "im", UserID: "u9", DisplayName: "客"})
	out := mustRecv(t, adapter)
	if out.Type != typeUnauthorized || out.Code[:6] != pairingPrefix {
		t.Fatalf("%+v", out)
	}
}

func dial(t *testing.T, sock string) net.Conn {
	t.Helper()
	var last error
	for i := 0; i < 20; i++ {
		c, err := net.DialTimeout("unix", sock, 200*time.Millisecond)
		if err == nil {
			return c
		}
		last = err
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("dial: %v", last)
	return nil
}

func mustSend(t *testing.T, c net.Conn, env Envelope) {
	t.Helper()
	if err := json.NewEncoder(c).Encode(env); err != nil {
		t.Fatal(err)
	}
}

func mustRecv(t *testing.T, c net.Conn) Envelope {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	var env Envelope
	if err := json.NewDecoder(c).Decode(&env); err != nil {
		t.Fatal(err)
	}
	return env
}
