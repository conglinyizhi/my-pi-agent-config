package main

import (
	"log"
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
//
// 另一层延迟是 hold（见 presence.go）：到了 card-delay 这个点，本机要还是有人，
// 这条就再排一回，不推。hold 期间同样认 settled 撤单，撤了就整条作废。
type cardQueue struct {
	delay time.Duration

	mu    sync.Mutex
	items map[string]*queuedCard
}

type queuedCard struct {
	timer *time.Timer
	// hold 可选：推卡前先问一句「现在能推吗」。返回 true = 先别推（本机有人），
	// 队列按 retry 再排一次；为 nil 就是到点即推
	hold func() bool
	// retry 是 hold 说「先别推」时的重试间隔
	retry time.Duration
	send  func()
}

func newCardQueue(delay time.Duration) *cardQueue {
	return &cardQueue{delay: delay, items: map[string]*queuedCard{}}
}

// push 记下一条待发卡。delay <= 0 时立刻 send，调用方不需要自己分流。
func (q *cardQueue) push(requestID string, send func()) {
	q.schedule(requestID, nil, 0, send)
}

// pushGated 跟 push 一样按 delay 入队，只是到点后先过一遍 hold：
// hold 返回 true 表示现在先别推（用户还在电脑前），队列按 retry 再问一次。
// 用在「本机有人就别打扰」那条路上，见 presence.go。
func (q *cardQueue) pushGated(requestID string, hold func() bool, retry time.Duration, send func()) {
	q.schedule(requestID, hold, retry, send)
}

func (q *cardQueue) schedule(requestID string, hold func() bool, retry time.Duration, send func()) {
	if q.delay <= 0 {
		// delay 关掉了就是要「立刻推」：那条路上不该再拿 hold 反过来压一会儿，
		// 否则 -card-delay 0 会被在场状态无声地否决掉
		send()
		return
	}
	item := &queuedCard{hold: hold, retry: retry, send: send}
	q.mu.Lock()
	// 同一 requestID 又进了一次队：旧的那条作废，免得一张卡发两遍
	if old := q.items[requestID]; old != nil {
		old.timer.Stop()
	}
	// 定时器必须在锁里建：cancel / rearm 会在别的 goroutine 上碰 item.timer，
	// 出了锁再赋值就是一个实打实的读写竞态
	item.timer = time.AfterFunc(q.delay, func() { q.run(requestID, item) })
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
	defer q.mu.Unlock()
	item, ok := q.items[requestID]
	if !ok {
		return false
	}
	delete(q.items, requestID)
	// Stop 在锁里做：rearm 也在锁里换 item.timer，放锁外两边就是读写竞态。
	// Stop 不等回调跑完，所以不存在「拿着锁等自己」的死锁
	item.timer.Stop()
	return true
}

// run 到点后的执行体：先过 hold（在场检查），再推。
//
// hold 要走一次网络往返问 hub，这中间这条 ask 可能被 settled 撤掉，所以 hold 之后再确认
// 一次它还挂在队列上——撤掉了就什么都不做，卡不能发。
func (q *cardQueue) run(requestID string, item *queuedCard) {
	if !q.live(requestID, item) {
		return
	}
	// retry 不是正数就没法重排（0 会变成忙等）：那种情况下 hold 不生效，照常推，
	// 宁可多打扰一次，也不把一条 ask 无声地压死
	if item.hold != nil && item.retry > 0 && item.hold() {
		// 重排成功才写这行：这条可能刚被 settled 撤掉了，那时写「延后」是假的
		if q.rearm(requestID, item) {
			log.Printf("ask %s：延后 %s 再看一次本机在场状态", requestID, item.retry)
		}
		return
	}
	if !q.live(requestID, item) {
		return
	}
	// send 在锁外跑：它会发飞书 API，拿着队列锁做网络调用会把 cancel 一起堵住
	item.send()
	q.drop(requestID, item)
}

// live 判断 item 还是不是这条 ask 当前有效的条目。被 cancel（结算撤单）、
// 或被后来的同 id 事件顶掉之后都返回 false。
func (q *cardQueue) live(requestID string, item *queuedCard) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.items[requestID] == item
}

// rearm 把这条重新排到 retry 之后（hold 说「先别推」时）。
// 条目本身留在队列里不摘：撤单还得认得它，presence-retry 那几分钟里用户答了
// 就要能撤掉。
func (q *cardQueue) rearm(requestID string, item *queuedCard) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.items[requestID] != item {
		return false
	}
	item.timer = time.AfterFunc(item.retry, func() { q.run(requestID, item) })
	return true
}

// drop 摘掉已经处理完的条目。send 期间被 cancel、或被后来的事件顶掉，
// map 里已经不是自己了，那就什么都别动。
func (q *cardQueue) drop(requestID string, item *queuedCard) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.items[requestID] == item {
		delete(q.items, requestID)
	}
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
