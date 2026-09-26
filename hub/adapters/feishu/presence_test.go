package main

import (
	"encoding/json"
	"net"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

// ── 假 hub：只认 hello / presence ────────────────────────────────────────
//
// 真 hub 在别的进程里，测试只关心这条短连接上的对话，所以自己起一个
// 只答 hello-ok / presence-ok 的假货，顺便记下来了几条连接、问了几次。

type fakeHubOpts struct {
	idle       time.Duration
	hasInput   bool
	mismatchID bool // 回执带一个对不上号的 id
	silent     bool // 收到 presence 不应答，测超时
	badType    bool // 回一个 presence 之外的类型，测异常回执
	noise      bool // 回执前先插一条 ask 广播，测乱入的消息被跳过
}

type fakeHub struct {
	ln    net.Listener
	path  string
	opts  fakeHubOpts
	conns atomic.Int32
	asks  atomic.Int32
}

func startFakeHub(t *testing.T, opts fakeHubOpts) *fakeHub {
	t.Helper()
	path := filepath.Join(t.TempDir(), "hub.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatalf("起假 hub 失败：%v", err)
	}
	h := &fakeHub{ln: ln, path: path, opts: opts}
	go h.serve()
	t.Cleanup(func() { _ = ln.Close() })
	return h
}

func (h *fakeHub) serve() {
	for {
		conn, err := h.ln.Accept()
		if err != nil {
			return
		}
		go h.handle(conn)
	}
}

func (h *fakeHub) handle(conn net.Conn) {
	defer conn.Close()
	h.conns.Add(1)
	dec := json.NewDecoder(conn)
	enc := json.NewEncoder(conn)

	var msg presenceMsg
	if dec.Decode(&msg) != nil || msg.Type != "hello" {
		return
	}
	if enc.Encode(presenceMsg{V: 1, Type: "hello-ok"}) != nil {
		return
	}
	if dec.Decode(&msg) != nil || msg.Type != "presence" {
		return
	}
	h.asks.Add(1)
	if h.opts.silent {
		return
	}
	if h.opts.badType {
		_ = enc.Encode(presenceMsg{V: 1, Type: "error", Message: "不认识的类型"})
		return
	}
	if h.opts.noise {
		// 这条短连接活着的那几毫秒里，hub 可能把 ask 广播也扇到这里
		_ = enc.Encode(presenceMsg{V: 1, Type: "event", ID: "ask-x", Message: "ask"})
	}
	id := msg.ID
	if h.opts.mismatchID {
		id = "别家的查询"
	}
	_ = enc.Encode(presenceMsg{
		V: 1, Type: "presence-ok", ID: id,
		IdleMs: h.opts.idle.Milliseconds(), HasInput: h.opts.hasInput,
	})
}

// waitUntil 等到 cond 成立；超时返回 false。定时器不好断言精确时刻，
// 测试只看「在窗口内发生 / 一直不发生」。
func waitUntil(cond func() bool, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(2 * time.Millisecond)
	}
	return cond()
}

// ── probePresence ──────────────────────────────────────────────────────

func TestProbePresenceReadsIdleAndInput(t *testing.T) {
	h := startFakeHub(t, fakeHubOpts{idle: 90 * time.Second, hasInput: true})
	idle, hasInput, err := probePresence(h.path, time.Second)
	if err != nil {
		t.Fatalf("查询应当成功：%v", err)
	}
	if !hasInput {
		t.Fatal("hasInput 没透传出来")
	}
	if idle != 90*time.Second {
		t.Fatalf("idle 应当 90s，实际 %s", idle)
	}
	if n := h.asks.Load(); n != 1 {
		t.Fatalf("应当只问一次，实际 %d 次", n)
	}
}

func TestProbePresenceOpensFreshConnectionPerQuery(t *testing.T) {
	// 主连接不能复用：它的 rpc 按 FIFO 取响应，会和 decide 串。
	// 这条测试盯的是「每次查询都是一条新连接」
	h := startFakeHub(t, fakeHubOpts{idle: time.Minute, hasInput: true})
	for i := 0; i < 2; i++ {
		if _, _, err := probePresence(h.path, time.Second); err != nil {
			t.Fatalf("第 %d 次查询失败：%v", i+1, err)
		}
	}
	if n := h.conns.Load(); n != 2 {
		t.Fatalf("两次查询应当开两条连接，实际 %d 条", n)
	}
}

func TestProbePresenceHubDown(t *testing.T) {
	// 路径上没有监听者：必须报错，不能假装「用户不在」
	path := filepath.Join(t.TempDir(), "没有这个.sock")
	if _, _, err := probePresence(path, 200*time.Millisecond); err == nil {
		t.Fatal("连不上 hub 时应当报错")
	}
}

func TestProbePresenceNoReplyTimesOut(t *testing.T) {
	h := startFakeHub(t, fakeHubOpts{silent: true})
	start := time.Now()
	if _, _, err := probePresence(h.path, 100*time.Millisecond); err == nil {
		t.Fatal("hub 不应答时应当报错")
	}
	if spent := time.Since(start); spent > 2*time.Second {
		t.Fatalf("超时没生效，等了 %s", spent)
	}
}

func TestProbePresenceRejectsMismatchedID(t *testing.T) {
	// 回执的 id 对不上号，说明答的不是我们那句，这种数不能用来判断人在不在
	h := startFakeHub(t, fakeHubOpts{idle: time.Second, hasInput: true, mismatchID: true})
	if _, _, err := probePresence(h.path, time.Second); err == nil {
		t.Fatal("id 不匹配时应当报错")
	}
}

func TestProbePresenceRejectsUnexpectedReply(t *testing.T) {
	// 旧版 hub 不认 presence，会回一条 error：按查询失败处理，不能当成「人不在」
	h := startFakeHub(t, fakeHubOpts{badType: true})
	if _, _, err := probePresence(h.path, time.Second); err == nil {
		t.Fatal("hub 回了 error 时应当报错")
	}
}

func TestProbePresenceSkipsStrayBroadcasts(t *testing.T) {
	// 这条短连接可能顺带收到 hub 的 ask 广播（它按角色扇出，不看是不是主连接）：
	// 那不是答案，跳过接着等自己那条
	h := startFakeHub(t, fakeHubOpts{idle: 2 * time.Minute, hasInput: true, noise: true})
	idle, hasInput, err := probePresence(h.path, time.Second)
	if err != nil {
		t.Fatalf("乱入的消息不该把查询打翻：%v", err)
	}
	if !hasInput || idle != 2*time.Minute {
		t.Fatalf("应当读到自己的回执：idle=%s hasInput=%v", idle, hasInput)
	}
}

// ── holdWhilePresent：推卡前的在场闸门 ──────────────────────────────────

func TestHoldWhilePresentDecides(t *testing.T) {
	cases := []struct {
		name   string
		opts   fakeHubOpts
		window time.Duration
		want   bool
	}{
		{"刚动过", fakeHubOpts{idle: 10 * time.Second, hasInput: true}, 5 * time.Minute, true},
		{"窗口边缘内", fakeHubOpts{idle: 4*time.Minute + 59*time.Second, hasInput: true}, 5 * time.Minute, true},
		{"离开够久", fakeHubOpts{idle: 10 * time.Minute, hasInput: true}, 5 * time.Minute, false},
		{"读不到输入设备", fakeHubOpts{idle: 0, hasInput: false}, 5 * time.Minute, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := startFakeHub(t, c.opts)
			a := &adapter{socketPath: h.path, presenceWindow: c.window}
			if got := a.holdWhilePresent("ask-1")(); got != c.want {
				t.Fatalf("hold 应当 %v，实际 %v", c.want, got)
			}
		})
	}
}

func TestHoldWhilePresentDisabledByZeroWindow(t *testing.T) {
	// -presence-window 0 = 关掉在场检查：连问都不该去问
	h := startFakeHub(t, fakeHubOpts{idle: time.Second, hasInput: true})
	a := &adapter{socketPath: h.path, presenceWindow: 0}
	if a.holdWhilePresent("ask-1")() {
		t.Fatal("窗口关掉了就不该拦")
	}
	if n := h.asks.Load(); n != 0 {
		t.Fatalf("窗口关掉了不该去查，实际查了 %d 次", n)
	}
}

func TestHoldWhilePresentQueryFailurePushesAnyway(t *testing.T) {
	// 查不到不等于用户不在：这条路上宁可多推一张卡，也不能把审批压着不发
	a := &adapter{socketPath: filepath.Join(t.TempDir(), "没有这个.sock"), presenceWindow: 5 * time.Minute}
	if a.holdWhilePresent("ask-1")() {
		t.Fatal("查询失败时应当放行（照常推卡）")
	}
}

// ── cardQueue 的 hold / retry ──────────────────────────────────────────

func TestCardQueueGateDefersThenSends(t *testing.T) {
	q := newCardQueue(20 * time.Millisecond)
	var holds, sends atomic.Int32
	q.pushGated("ask-1", func() bool {
		// 前两次说「人在」，第三次放行
		return holds.Add(1) <= 2
	}, 30*time.Millisecond, func() { sends.Add(1) })

	if !waitUntil(func() bool { return sends.Load() == 1 }, 3*time.Second) {
		t.Fatal("闸门放行后应当把卡推出去")
	}
	if n := holds.Load(); n != 3 {
		t.Fatalf("应当问三次（两次在、一次不在），实际 %d 次", n)
	}
	// 推完就该从队列里摘掉，不能自己再排一轮
	time.Sleep(100 * time.Millisecond)
	if n := sends.Load(); n != 1 {
		t.Fatalf("推完不该再发，实际发了 %d 次", n)
	}
	if n := holds.Load(); n != 3 {
		t.Fatalf("推完不该再问，实际问了 %d 次", n)
	}
}

func TestCardQueueGateRetryCanBeCancelled(t *testing.T) {
	// 用户在重试等待期间在本机答了（settled 撤单）：卡不能再推出去
	q := newCardQueue(10 * time.Millisecond)
	var holds, sends atomic.Int32
	q.pushGated("ask-1", func() bool { holds.Add(1); return true }, 80*time.Millisecond, func() { sends.Add(1) })

	if !waitUntil(func() bool { return holds.Load() >= 1 }, time.Second) {
		t.Fatal("hold 没跑起来")
	}
	if !q.cancel("ask-1") {
		t.Fatal("重试等待期间应当撤得到")
	}
	time.Sleep(200 * time.Millisecond)
	if n := sends.Load(); n != 0 {
		t.Fatalf("撤单后不该再推，实际推了 %d 次", n)
	}
	if n := holds.Load(); n != 1 {
		t.Fatalf("撤单后不该再问在场状态，实际问了 %d 次", n)
	}
}

func TestCardQueueCancelWhileGateRunning(t *testing.T) {
	// 撤单落在 hold 在途（presence 查询还没回来）的时候：
	// 闸门之后必须再确认一次这条还活着，不能因为闸门放行就推
	q := newCardQueue(5 * time.Millisecond)
	started := make(chan struct{})
	release := make(chan struct{})
	var sends atomic.Int32
	q.pushGated("ask-1", func() bool {
		close(started)
		<-release
		return false // 闸门最后说「可以推」
	}, time.Second, func() { sends.Add(1) })

	<-started
	if !q.cancel("ask-1") {
		t.Fatal("查询在途时应当撤得到")
	}
	close(release)
	time.Sleep(100 * time.Millisecond)
	if n := sends.Load(); n != 0 {
		t.Fatalf("撤单后即使闸门放行也不能推，实际推了 %d 次", n)
	}
}

func TestCardQueueGateIgnoredWhenDelayZero(t *testing.T) {
	// -card-delay 0 就是「立刻推」：那条路上不该再拿在场状态反过来压
	q := newCardQueue(0)
	var asked, sent bool
	q.pushGated("ask-1", func() bool { asked = true; return true }, time.Second, func() { sent = true })
	if !sent {
		t.Fatal("delay=0 应当当场就发")
	}
	if asked {
		t.Fatal("delay=0 时不该再查在场状态")
	}
}

func TestCardQueueNonPositiveRetryPushesAnyway(t *testing.T) {
	// retry 不是正数就没法重排（0 秒会变成忙等）：宁可多打扰一次，也别把 ask 压死
	q := newCardQueue(5 * time.Millisecond)
	fired := make(chan struct{}, 1)
	q.pushGated("ask-1", func() bool { return true }, 0, func() { fired <- struct{}{} })
	if !waitFired(fired, time.Second) {
		t.Fatal("retry 不是正数时应当照常推")
	}
}

// ── onAskEvent：urgent 不走在场检查 ────────────────────────────────────

func TestOnAskEventPresencePath(t *testing.T) {
	h := startFakeHub(t, fakeHubOpts{idle: time.Second, hasInput: true})
	a := &adapter{
		chats:          map[string]string{},
		cards:          map[string]askTarget{},
		delay:          newCardQueue(10 * time.Millisecond),
		socketPath:     h.path,
		presenceWindow: 5 * time.Minute,
		presenceRetry:  time.Hour, // 只让它延后一次，测试里别再排下一轮
	}
	a.onAskEvent(envelope{Event: "ask", RequestID: "ask-1", Kind: "approval", ExpiresAt: ""})

	if !waitUntil(func() bool { return h.asks.Load() >= 1 }, time.Second) {
		t.Fatal("非 urgent 的延迟路径到点后应当查一次在场状态")
	}
	// 本机有人：这条被延后重排，卡没推。撤得到就说明它还挂在队列里，
	// 也说明这段时间里来一条 settled 撤单是能拦住它的
	if !a.delay.cancel("ask-1") {
		t.Fatal("延后重试的条目应当还留在队列里，否则撤单就撤不到了")
	}
}

func TestOnAskEventUrgentSkipsPresence(t *testing.T) {
	h := startFakeHub(t, fakeHubOpts{idle: time.Second, hasInput: true})
	a := &adapter{
		chats:          map[string]string{},
		cards:          map[string]askTarget{},
		delay:          newCardQueue(time.Hour), // 延迟设很长，urgent 也不该等
		socketPath:     h.path,
		presenceWindow: 5 * time.Minute,
		presenceRetry:  time.Minute,
	}
	a.onAskEvent(envelope{
		Event: "ask", RequestID: "ask-urgent", Kind: "approval",
		Payload: map[string]any{"urgent": true},
	})

	if n := h.asks.Load(); n != 0 {
		t.Fatalf("urgent 不该查在场状态，实际查了 %d 次", n)
	}
	if a.delay.cancel("ask-urgent") {
		t.Fatal("urgent 应当直接推，不该留在延迟队列里")
	}
}
