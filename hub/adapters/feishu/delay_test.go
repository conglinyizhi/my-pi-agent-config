package main

import (
	"sync/atomic"
	"testing"
	"time"
)

// ── cardQueue：延迟发卡 + 结算撤单 ──────────────────────────────────────
//
// 定时器不好断言精确时刻，测试只看「在窗口内发生 / 一直不发生」，
// 延时取毫秒级、窗口取足够宽，避免 CI 上抖动。

// waitFired 等 send 被调用；超时返回 false
func waitFired(fired <-chan struct{}, timeout time.Duration) bool {
	select {
	case <-fired:
		return true
	case <-time.After(timeout):
		return false
	}
}

func TestCardQueueSendsAfterDelay(t *testing.T) {
	q := newCardQueue(30 * time.Millisecond)
	fired := make(chan struct{}, 1)
	q.push("ask-1", func() { fired <- struct{}{} })

	if waitFired(fired, 10*time.Millisecond) {
		t.Fatal("还没到点就发了")
	}
	if !waitFired(fired, time.Second) {
		t.Fatal("到点后没发")
	}
}

func TestCardQueueImmediateWhenDelayZero(t *testing.T) {
	// 参数给 0（或负数）就是关掉延迟：调用方不该自己分流
	q := newCardQueue(0)
	called := false
	q.push("ask-1", func() { called = true })
	if !called {
		t.Fatal("delay=0 应当当场就发")
	}
}

func TestCardQueueCancelBeforeFire(t *testing.T) {
	q := newCardQueue(40 * time.Millisecond)
	var calls atomic.Int32
	q.push("ask-1", func() { calls.Add(1) })

	if !q.cancel("ask-1") {
		t.Fatal("撤单应当成功")
	}
	time.Sleep(120 * time.Millisecond)
	if n := calls.Load(); n != 0 {
		t.Fatalf("撤单后不该发，实际发了 %d 次", n)
	}
}

func TestCardQueueCancelAfterFire(t *testing.T) {
	// 卡已经发出去了：撤单要报 false，让调用方知道该去改卡而不是当没发生过
	q := newCardQueue(10 * time.Millisecond)
	fired := make(chan struct{}, 1)
	q.push("ask-1", func() { fired <- struct{}{} })
	if !waitFired(fired, time.Second) {
		t.Fatal("到点后没发")
	}
	if q.cancel("ask-1") {
		t.Fatal("已经发过的卡不该能撤")
	}
}

func TestCardQueueCancelUnknownIsFalse(t *testing.T) {
	if newCardQueue(time.Second).cancel("nope") {
		t.Fatal("没进过队的 requestID 不该撤得到")
	}
}

func TestCardQueueKeepsLatestOnDuplicate(t *testing.T) {
	// 同一 requestID 重复进队（重推 / 重连后的重复事件）只发最后一条，
	// 否则用户会收到两张一样的卡
	q := newCardQueue(30 * time.Millisecond)
	var first, second atomic.Int32
	q.push("ask-1", func() { first.Add(1) })
	q.push("ask-1", func() { second.Add(1) })

	time.Sleep(150 * time.Millisecond)
	if n := first.Load(); n != 0 {
		t.Fatalf("被顶掉的那条不该发，实际发了 %d 次", n)
	}
	if n := second.Load(); n != 1 {
		t.Fatalf("最后一条应当发一次，实际 %d 次", n)
	}
}

// ── pushNow / payloadFlag：urgent 跳过 card-delay ───────────────────────

func TestCardQueuePushNowIgnoresDelay(t *testing.T) {
	q := newCardQueue(time.Hour)
	fired := make(chan struct{}, 1)
	q.pushNow("ask-urgent", func() { fired <- struct{}{} })

	if !waitFired(fired, 50*time.Millisecond) {
		t.Fatal("urgent 应当立刻发卡，不受 delay 影响")
	}
	if n := len(q.items); n != 0 {
		t.Fatalf("立刻发出的这条不该留在队列里，剩余 %d 条", n)
	}
}

// 同一 id 先入队、后来变成 urgent：旧的定时器必须作废，否则一张卡发两遍
func TestCardQueuePushNowCancelsPending(t *testing.T) {
	q := newCardQueue(40 * time.Millisecond)
	var queued, urgent atomic.Int32
	q.push("ask-1", func() { queued.Add(1) })
	q.pushNow("ask-1", func() { urgent.Add(1) })

	if urgent.Load() != 1 {
		t.Fatalf("urgent 那条应当立刻发一次，实际 %d", urgent.Load())
	}
	time.Sleep(120 * time.Millisecond)
	if n := queued.Load(); n != 0 {
		t.Fatalf("被 urgent 顶掉的延迟条目不该再发，实际发了 %d 次", n)
	}
}

func TestPayloadFlag(t *testing.T) {
	if !payloadFlag(map[string]any{"urgent": true}, "urgent") {
		t.Fatal("显式 true 应当算开启")
	}
	for name, payload := range map[string]map[string]any{
		"缺字段":     {},
		"显式 false": {"urgent": false},
		"类型不对":    {"urgent": "true"},
		"null":     {"urgent": nil},
	} {
		if payloadFlag(payload, "urgent") {
			t.Fatalf("%s 不该算开启（宁可不推，也不能把脏值当开启）", name)
		}
	}
}

// ── askExpired：到点时已经过期的卡不发 ─────────────────────────────────

func TestAskExpired(t *testing.T) {
	past := time.Now().Add(-time.Minute).UTC().Format(time.RFC3339)
	future := time.Now().Add(time.Minute).UTC().Format(time.RFC3339)
	if !askExpired(past) {
		t.Fatal("过期时间在过去应当算过期")
	}
	if askExpired(future) {
		t.Fatal("过期时间在未来不该算过期")
	}
	if askExpired("") {
		t.Fatal("没带过期时间不该算过期")
	}
	if askExpired("不是时间") {
		t.Fatal("解析不了时按未过期处理，不能把通知吞掉")
	}
}
