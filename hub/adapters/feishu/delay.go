package main

import (
	"sync"
	"time"
)

// cardQueue 管「延迟发卡」：决策请求先进队列，到点才交给 send；期间结算了就撤单。
//
// 为什么要延迟：用户常常就在屏幕前，本机闸门窗（审批）或本地 TUI（提问）已经把决策
// 拿走了，那种情形下再推一张 IM 卡纯属打扰；飞书这边还额外花一次 API 调用，
// 月额度不该这么白花。
//
// 撤单只认 hub 的 settled 广播，队列因此不必猜 ask 在 hub 里什么状态：
// 撤得到，说明卡还没发出去；撤不到，说明已经发了，那就照常改卡。
type cardQueue struct {
	delay time.Duration

	mu    sync.Mutex
	items map[string]*queuedCard
}

type queuedCard struct {
	timer *time.Timer
}

func newCardQueue(delay time.Duration) *cardQueue {
	return &cardQueue{delay: delay, items: map[string]*queuedCard{}}
}

// push 记下一条待发卡。delay <= 0 时立刻 send，调用方不需要自己分流。
func (q *cardQueue) push(requestID string, send func()) {
	if q.delay <= 0 {
		send()
		return
	}
	item := &queuedCard{}
	q.mu.Lock()
	// 同一 requestID 又进了一次队：旧的那条作废，免得一张卡发两遍
	if old := q.items[requestID]; old != nil {
		old.timer.Stop()
	}
	// 定时器必须在锁里建：cancel 会在别的 goroutine 上碰 item.timer，
	// 出了锁再赋值就是一个实打实的读写竞态
	item.timer = time.AfterFunc(q.delay, func() {
		if !q.claim(requestID, item) {
			return
		}
		send()
	})
	q.items[requestID] = item
	q.mu.Unlock()
}

// pushNow 立刻发卡：先撤掉同 id 的待发条目（免得一张卡发两遍），再直接 send。
// 用在发起方声明 urgent 的场景：本地没人能答，或者这件事本来就要人马上到场，
// 那种时候 card-delay 只会担误事。
func (q *cardQueue) pushNow(requestID string, send func()) {
	q.cancel(requestID)
	send()
}

// cancel 撤单，返回有没有撤到。结算（用户答了、超时、abort）都走这条。
func (q *cardQueue) cancel(requestID string) bool {
	q.mu.Lock()
	item, ok := q.items[requestID]
	if ok {
		delete(q.items, requestID)
	}
	q.mu.Unlock()
	if !ok {
		return false
	}
	item.timer.Stop()
	return true
}

// claim 把到点的这条从队列里摘走。已被 cancel、或已被后一条顶掉的返回 false，
// 那两种情况都不该再发。
func (q *cardQueue) claim(requestID string, item *queuedCard) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	cur, ok := q.items[requestID]
	if !ok || cur != item {
		return false
	}
	delete(q.items, requestID)
	return true
}

// payloadFlag 读 payload 里的布尔标记。缺省、类型不对、或显式 false 都当没开：
// 这类开关宁可不生效，也不要因为一个脏值把卡强行推出去。
func payloadFlag(payload map[string]any, key string) bool {
	v, ok := payload[key].(bool)
	return ok && v
}

// askExpired 判断这条 ask 的有效期是不是已经过去了。
// 解析不了就当没过期（宁可按原样推一张卡，也不要因为格式问题把通知吞掉）。
func askExpired(expiresAt string) bool {
	if expiresAt == "" {
		return false
	}
	t, err := time.Parse(time.RFC3339, expiresAt)
	if err != nil {
		return false
	}
	return !time.Now().Before(t)
}
