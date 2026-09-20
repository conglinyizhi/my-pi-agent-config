package main

import (
	"encoding/json"
	"net"
	"path/filepath"
	"sync"
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

// 每条连接一个 Decoder：Decoder 会预读，每次新键一个就会把上一次缓冲住的字节丢掉，
// 并发的两条消息同一次到达时，第二条只能读到半截 JSON。
var testDecoders = struct {
	sync.Mutex
	m map[net.Conn]*json.Decoder
}{m: map[net.Conn]*json.Decoder{}}

func mustRecv(t *testing.T, c net.Conn) Envelope {
	t.Helper()
	testDecoders.Lock()
	dec, ok := testDecoders.m[c]
	if !ok {
		dec = json.NewDecoder(c)
		testDecoders.m[c] = dec
	}
	testDecoders.Unlock()
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	var env Envelope
	if err := dec.Decode(&env); err != nil {
		t.Fatal(err)
	}
	return env
}

func TestAskEventCarriesPrincipals(t *testing.T) {
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

	// 配对码本来只在本机贴；这里直接走 hub 内部接口造一个已授权账号
	pair, _, err := h.Pair("feishu", "ou_1", "丛林")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.Grant(pair.Code); err != nil {
		t.Fatal(err)
	}

	adapter := dial(t, sock)
	defer adapter.Close()
	mustSend(t, adapter, Envelope{V: 1, Type: typeHello, Role: roleAdapter})
	mustRecv(t, adapter)

	pi := dial(t, sock)
	defer pi.Close()
	mustSend(t, pi, Envelope{V: 1, Type: typeHello, Role: rolePI})
	mustRecv(t, pi)

	mustSend(t, pi, Envelope{
		V: 1, Type: typeAsk, Kind: "bash", RequestID: "req-principals",
		SessionID: "sess", Payload: map[string]any{"command": "rm -rf /"},
		TimeoutMs: 60_000,
	})
	if ok := mustRecv(t, pi); ok.Type != typeAskOK {
		t.Fatalf("ask-ok %+v", ok)
	}

	ev := mustRecv(t, adapter)
	if ev.Type != typeEvent || ev.RequestID != "req-principals" {
		t.Fatalf("event %+v", ev)
	}
	if len(ev.Principals) != 1 || ev.Principals[0].Channel != "feishu" || ev.Principals[0].UserID != "ou_1" {
		t.Fatalf("授权名单没随审批事件下发：%+v", ev.Principals)
	}
}

func TestDecideRepliesAck(t *testing.T) {
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

	pair, _, err := h.Pair("feishu", "ou_1", "丛林")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.Grant(pair.Code); err != nil {
		t.Fatal(err)
	}

	adapter := dial(t, sock)
	defer adapter.Close()
	mustSend(t, adapter, Envelope{V: 1, Type: typeHello, Role: roleAdapter})
	mustRecv(t, adapter)

	pi := dial(t, sock)
	defer pi.Close()
	mustSend(t, pi, Envelope{V: 1, Type: typeHello, Role: rolePI})
	mustRecv(t, pi)
	mustSend(t, pi, Envelope{
		V: 1, Type: typeAsk, Kind: "bash", RequestID: "req-ack",
		SessionID: "sess", Payload: map[string]any{"command": "echo hi"},
		TimeoutMs: 60_000,
	})
	if ok := mustRecv(t, pi); ok.Type != typeAskOK {
		t.Fatalf("ask-ok %+v", ok)
	}
	if ev := mustRecv(t, adapter); ev.Type != typeEvent {
		t.Fatalf("event %+v", ev)
	}

	mustSend(t, adapter, Envelope{
		V: 1, Type: typeDecide, RequestID: "req-ack", Action: "allow",
		Principal: &Principal{Channel: "feishu", UserID: "ou_1"},
	})
	// 回执要立刻到，不能等适配器那边 8 秒 RPC 超时
	ack := mustRecv(t, adapter)
	if ack.Type != typeDecideOK || ack.RequestID != "req-ack" || ack.Action != "allow" {
		t.Fatalf("回执 %+v", ack)
	}
	// 随后还要有 settled 广播，适配器靠它改卡
	settled := mustRecv(t, adapter)
	if settled.Type != typeSettled || settled.RequestID != "req-ack" {
		t.Fatalf("settled %+v", settled)
	}
}
