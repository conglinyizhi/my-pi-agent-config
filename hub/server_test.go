package main

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"slices"
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

// startTestHub 起一个跳过 SO_PEERCRED 的本机测试 hub，返回 socket 与 Server。
func startTestHub(t *testing.T) (string, *Server) {
	t.Helper()
	sock := filepath.Join(t.TempDir(), "hub.sock")
	h := newHub("", time.Hour, 15*time.Minute, nil)
	s := newServer(h, sock)
	s.skipPeer = true
	if err := s.Listen(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	go s.Serve()
	return sock, s
}

// grantPrincipal 直接走 hub 内部接口造一个已授权账号，省掉配对码那段。
func grantPrincipal(t *testing.T, s *Server, channel, userID string) *Principal {
	t.Helper()
	pair, _, err := s.hub.Pair(channel, userID, "")
	if err != nil {
		t.Fatal(err)
	}
	p, err := s.hub.Grant(pair.Code)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

// mustRecvRaw 用已注册的 Decoder 把整行收成字段表，用来核对线上字段名和 omitempty。
func mustRecvRaw(t *testing.T, c net.Conn) map[string]json.RawMessage {
	t.Helper()
	testDecoders.Lock()
	dec, ok := testDecoders.m[c]
	if !ok {
		dec = json.NewDecoder(c)
		testDecoders.m[c] = dec
	}
	testDecoders.Unlock()
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	var raw map[string]json.RawMessage
	if err := dec.Decode(&raw); err != nil {
		t.Fatal(err)
	}
	return raw
}

// 结构化应答要一字不差地进 settled，包括 wasCustom 那条。
func TestSettledCarriesAnswers(t *testing.T) {
	sock, s := startTestHub(t)
	p := grantPrincipal(t, s, "im", "u1")

	adapter := dial(t, sock)
	defer adapter.Close()
	mustSend(t, adapter, Envelope{V: 1, Type: typeHello, Role: roleAdapter})
	mustRecv(t, adapter)

	pi := dial(t, sock)
	defer pi.Close()
	mustSend(t, pi, Envelope{V: 1, Type: typeHello, Role: rolePI})
	mustRecv(t, pi)

	mustSend(t, pi, Envelope{
		V: 1, Type: typeAsk, Kind: "question", RequestID: "req-answers",
		SessionID: "sess", Payload: map[string]any{"title": "怎么发"},
		TimeoutMs: 60_000,
	})
	if ok := mustRecv(t, pi); ok.Type != typeAskOK {
		t.Fatalf("ask-ok %+v", ok)
	}
	if ev := mustRecv(t, adapter); ev.Type != typeEvent {
		t.Fatalf("event %+v", ev)
	}

	answers := []Answer{
		{ID: "q1", Value: "canary", Label: "先灰度"},
		{ID: "q2", Value: "我自己填的", Label: "其他", WasCustom: true},
	}
	mustSend(t, adapter, Envelope{
		V: 1, Type: typeDecide, RequestID: "req-answers", Action: "allow",
		Principal: p, Answers: answers,
	})
	if ack := mustRecv(t, adapter); ack.Type != typeDecideOK {
		t.Fatalf("回执 %+v", ack)
	}

	raw := mustRecvRaw(t, pi)
	if string(raw["type"]) != `"settled"` {
		t.Fatalf("pi 没收到 settled：%v", raw)
	}
	want, err := json.Marshal(answers)
	if err != nil {
		t.Fatal(err)
	}
	if got := string(raw["answers"]); got != string(want) {
		t.Fatalf("answers 没原样透传\n got %s\nwant %s", got, want)
	}

	var settled Envelope
	data, err := json.Marshal(raw)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &settled); err != nil {
		t.Fatal(err)
	}
	if len(settled.Answers) != 2 || settled.Answers[1].ID != "q2" || !settled.Answers[1].WasCustom {
		t.Fatalf("settled.answers %+v", settled.Answers)
	}
}

// 老路径不带 answers，settled 里连字段都不该出现。
func TestSettledWithoutAnswers(t *testing.T) {
	sock, s := startTestHub(t)
	p := grantPrincipal(t, s, "im", "u1")

	adapter := dial(t, sock)
	defer adapter.Close()
	mustSend(t, adapter, Envelope{V: 1, Type: typeHello, Role: roleAdapter})
	mustRecv(t, adapter)

	pi := dial(t, sock)
	defer pi.Close()
	mustSend(t, pi, Envelope{V: 1, Type: typeHello, Role: rolePI})
	mustRecv(t, pi)

	mustSend(t, pi, Envelope{
		V: 1, Type: typeAsk, Kind: "bash", RequestID: "req-noanswers",
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
		V: 1, Type: typeDecide, RequestID: "req-noanswers", Action: "allow",
		Principal: p,
	})
	if ack := mustRecv(t, adapter); ack.Type != typeDecideOK {
		t.Fatalf("回执 %+v", ack)
	}

	raw := mustRecvRaw(t, pi)
	if string(raw["type"]) != `"settled"` || string(raw["action"]) != `"allow"` {
		t.Fatalf("settled %v", raw)
	}
	if got, ok := raw["answers"]; ok {
		t.Fatalf("旧路径不该带 answers：%s", got)
	}
}

// ask-ok 要回报适配器数：0 个要说 0，2 个要说 2，role=pi 的连接不算。
func TestAskOKReportsAdapterCount(t *testing.T) {
	sock, _ := startTestHub(t)

	pi := dial(t, sock)
	defer pi.Close()
	mustSend(t, pi, Envelope{V: 1, Type: typeHello, Role: rolePI})
	mustRecv(t, pi)

	// 还没有适配器接入
	mustSend(t, pi, Envelope{
		V: 1, Type: typeAsk, Kind: "question", RequestID: "req-noadapter",
		SessionID: "sess", TimeoutMs: 60_000,
	})
	if ok := mustRecv(t, pi); ok.Adapters != 0 {
		t.Fatalf("没有适配器时 adapters=%d", ok.Adapters)
	}

	for i := 0; i < 2; i++ {
		adapter := dial(t, sock)
		defer adapter.Close()
		mustSend(t, adapter, Envelope{V: 1, Type: typeHello, Role: roleAdapter})
		if hello := mustRecv(t, adapter); hello.Type != typeHelloOK {
			t.Fatalf("hello-ok %+v", hello)
		}
	}

	// 再加一条 pi 连接，它不该被算进去
	pi2 := dial(t, sock)
	defer pi2.Close()
	mustSend(t, pi2, Envelope{V: 1, Type: typeHello, Role: rolePI})
	mustRecv(t, pi2)

	mustSend(t, pi, Envelope{
		V: 1, Type: typeAsk, Kind: "question", RequestID: "req-twoadapters",
		SessionID: "sess", TimeoutMs: 60_000,
	})
	if ok := mustRecv(t, pi); ok.Adapters != 2 {
		t.Fatalf("两个适配器时 adapters=%d", ok.Adapters)
	}
}

func TestAskNoLocalGUISkipsGateWindow(t *testing.T) {
	sock, s := startTestHub(t)

	var mu sync.Mutex
	var launched []string
	s.launchGUI = func(ask *Ask) {
		mu.Lock()
		launched = append(launched, ask.RequestID)
		mu.Unlock()
	}

	pi := dial(t, sock)
	defer pi.Close()
	mustSend(t, pi, Envelope{V: 1, Type: typeHello, Role: rolePI})
	mustRecv(t, pi)

	send := func(requestID string, noLocalGUI bool) {
		mustSend(t, pi, Envelope{
			V: 1, Type: typeAsk, Kind: "question", RequestID: requestID,
			SessionID: "sess", Payload: map[string]any{"questions": []any{}},
			TimeoutMs: 60_000, NoLocalGUI: noLocalGUI,
		})
		if ok := mustRecv(t, pi); ok.Type != typeAskOK {
			t.Fatalf("ask-ok %+v", ok)
		}
	}

	// 发起方声明了就不拉窗：本机闸门窗只有审批形态，提问弹出来是读不懂的空表
	send("q-skip-gui", true)
	// 没声明的照旧拉起（审批路径不受影响）
	send("q-with-gui", false)

	deadline := time.Now().Add(time.Second)
	for {
		mu.Lock()
		got := append([]string(nil), launched...)
		mu.Unlock()
		if len(got) > 0 || time.Now().After(deadline) {
			// 断言到具体是哪条：只数总数的话，「该弹的没弹、不该弹的弹了」也会凑出 1
			for _, id := range got {
				if id == "q-skip-gui" {
					t.Fatalf("声明了 noLocalGUI 还是弹了窗：%v", got)
				}
			}
			if len(got) != 1 || got[0] != "q-with-gui" {
				t.Fatalf("该弹的只有 q-with-gui，实际 %v", got)
			}
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// writeFakeGate 造一个假闸门窗：不弹真窗口，只按 hub 的调用约定把 response.json 写出去
// （$1=gate，$2=request.json，$3=response.json）。
func writeFakeGate(t *testing.T, response map[string]any) string {
	t.Helper()
	data, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(t.TempDir(), "fake-gate.sh")
	script := "#!/bin/sh\ncat > \"$3\" <<'PIHUB_GATE_EOF'\n" + string(data) + "\nPIHUB_GATE_EOF\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return bin
}

// askSandboxAllow 让假 pi 提一条 sandbox-allow，返回收到 settled 的连接。
func askSandboxAllow(t *testing.T, sock, requestID string) net.Conn {
	t.Helper()
	pi := dial(t, sock)
	t.Cleanup(func() { pi.Close() })
	mustSend(t, pi, Envelope{V: 1, Type: typeHello, Role: rolePI})
	if hello := mustRecv(t, pi); hello.Type != typeHelloOK {
		t.Fatalf("hello-ok %+v", hello)
	}
	mustSend(t, pi, Envelope{
		V: 1, Type: typeAsk, Kind: "sandbox-allow", RequestID: requestID,
		SessionID: "sess",
		Payload: map[string]any{
			"command": "touch /opt/a", "permission": "write-paths",
			"writePaths": []string{"/opt/a", "/srv/b", "/etc/c"},
		},
		TimeoutMs: 60_000,
	})
	if ok := mustRecv(t, pi); ok.Type != typeAskOK || ok.RequestID != requestID {
		t.Fatalf("ask-ok %+v", ok)
	}
	return pi
}

// 闸门窗里编辑过的执行范围要一路跟到 pi：窗口写 response.json → hub 解析 → Decide → settled。
// 直连 GUI 时这段本来是通的，走 hub 时最容易在半路丢成「pi 只看到申请值」。
func TestGateGUIWritePathsReachSettled(t *testing.T) {
	sock, s := startTestHub(t)
	s.launchGateGUI(writeFakeGate(t, map[string]any{
		"action":      "allow",
		"comment":     "只批这两个",
		"pathActions": []map[string]any{{"path": "/opt/a", "list": "allow"}},
		"writePaths":  []string{"/opt/a", "/srv/b"},
	}))

	pi := askSandboxAllow(t, sock, "req-gui-wp")
	settled := mustRecv(t, pi)
	if settled.Type != typeSettled || settled.Action != "allow" || settled.By != byGUI {
		t.Fatalf("settled %+v", settled)
	}
	if !slices.Equal(settled.WritePaths, []string{"/opt/a", "/srv/b"}) {
		t.Fatalf("编辑后的执行范围没透传到 pi：%v", settled.WritePaths)
	}
	if len(settled.PathActions) != 1 || settled.PathActions[0].List != "allow" || settled.PathActions[0].Path != "/opt/a" {
		t.Fatalf("pathActions 也跟着一起核对：%+v", settled.PathActions)
	}
}

// 旧版 GUI 的响应里没有 writePaths：settled 里连字段都不该出现，
// pi 侧 parseGuiDecision 看到 undefined 才会沿用申请值。
func TestGateGUIWithoutWritePaths(t *testing.T) {
	sock, s := startTestHub(t)
	s.launchGateGUI(writeFakeGate(t, map[string]any{"action": "allow", "comment": "旧窗口"}))

	pi := askSandboxAllow(t, sock, "req-gui-nowp")
	raw := mustRecvRaw(t, pi)
	if string(raw["type"]) != `"settled"` || string(raw["action"]) != `"allow"` {
		t.Fatalf("settled %v", raw)
	}
	if got, ok := raw["writePaths"]; ok {
		t.Fatalf("旧 GUI 不该带出 writePaths：%s", got)
	}
}

// 远端（适配器 / 本机 GUI 连 socket）的 decide 带 writePaths，settled 也要带。
func TestSettledCarriesDecideWritePaths(t *testing.T) {
	sock, s := startTestHub(t)
	p := grantPrincipal(t, s, "im", "u1")

	adapter := dial(t, sock)
	defer adapter.Close()
	mustSend(t, adapter, Envelope{V: 1, Type: typeHello, Role: roleAdapter})
	mustRecv(t, adapter)

	pi := askSandboxAllow(t, sock, "req-decide-wp")
	if ev := mustRecv(t, adapter); ev.Type != typeEvent {
		t.Fatalf("event %+v", ev)
	}

	mustSend(t, adapter, Envelope{
		V: 1, Type: typeDecide, RequestID: "req-decide-wp", Action: "allow",
		Principal: p, WritePaths: []string{"/opt/a"},
	})
	if ack := mustRecv(t, adapter); ack.Type != typeDecideOK {
		t.Fatalf("回执 %+v", ack)
	}

	raw := mustRecvRaw(t, pi)
	if string(raw["type"]) != `"settled"` {
		t.Fatalf("pi 没收到 settled：%v", raw)
	}
	if got := string(raw["writePaths"]); got != `["/opt/a"]` {
		t.Fatalf("writePaths 没原样透传：%s", got)
	}
}
