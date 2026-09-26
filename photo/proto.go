package main

import "time"

// 协议版本。socket 与 HTTP 两边都按 v:1 走，加字段不改版本，改语义才改。
const protocolVersion = 1

// socket 上唯一的合法角色。手机走 HTTP，不上 socket：
// 手机没有 uid 可信可言（同一个 wifi 里任何人都在），给它一条 socket 等于把锁交出去。
const rolePI = "pi"

const (
	typeHello     = "hello"
	typeHelloOK   = "hello-ok"
	typeAttach    = "attach"
	typeAttachOK  = "attach-ok"
	typeBusy      = "busy"
	typeDetach    = "detach"
	typeDetachOK  = "detach-ok"
	typePing      = "ping"
	typePong      = "pong"
	typeAck       = "ack"
	typeAckOK     = "ack-ok"
	typeURL       = "url"
	typeURLOK     = "url-ok"
	typeArrived   = "arrived"
	typeFinish    = "finish"
	typePreempted = "preempted"
	typeError     = "error"
)

// 抢占原因是封闭集合：pi 侧要据此决定是「静静重连」还是「提示用户有人抢了」。
const (
	reasonStale  = "stale"
	reasonForced = "forced"
	// byWeb 是 finish 事件的发起方，目前只有网页上的「结束」按钮。
	byWeb = "web"
)

// Envelope 是 socket 上的一行 JSON。未知字段一律忽略，加字段不动老对端。
//
// Queued / Moved / Count 用指针：契约里写了这三个字段，而 0 是有意义的取值
// （队列空、没东西可搬、这轮一张没推）。用带 omitempty 的值类型，0 会从线上消失，
// 对端只能靠「缺了就是 0」去猜——hub 在 IdleMs / HasInput 上踩过同一个坑，
// 这里照同样的办法处理：字段在不在，由发送方明确决定。
type Envelope struct {
	V         int         `json:"v"`
	Type      string      `json:"type"`
	ID        string      `json:"id,omitempty"`
	Role      string      `json:"role,omitempty"`
	SessionID string      `json:"sessionId,omitempty"`
	Name      string      `json:"name,omitempty"`
	Force     bool        `json:"force,omitempty"`
	Queued    *int        `json:"queued,omitempty"`
	Holder    *HolderInfo `json:"holder,omitempty"`
	Items     []Item      `json:"items,omitempty"`
	IDs       []string    `json:"ids,omitempty"`
	Moved     *int        `json:"moved,omitempty"`
	URL       string      `json:"url,omitempty"`
	By        string      `json:"by,omitempty"`
	Count     *int        `json:"count,omitempty"`
	Reason    string      `json:"reason,omitempty"`
	Message   string      `json:"message,omitempty"`
	PeerUID   uint32      `json:"peerUid,omitempty"`
}

// num 取一个整数的地址，给上面那三个字段用。
func num(n int) *int { return &n }

// HolderInfo 是锁的现持有者。since 用 RFC3339 (UTC)：
// pi 侧要拿它和本地时间比，本地化过的时间串在跨时区/换机器时都是坑。
type HolderInfo struct {
	SessionID string `json:"sessionId"`
	Name      string `json:"name,omitempty"`
	Since     string `json:"since"`
}

// Item 是一条已落盘的图。path 是绝对路径，pi 直接读这个路径，
// 不去猜目录布局：布局是守护的实现细节。
type Item struct {
	ID    string `json:"id"`
	Path  string `json:"path"`
	Mime  string `json:"mime"`
	Bytes int64  `json:"bytes"`
	TS    string `json:"ts"`
}

func rfc3339(t time.Time) string {
	return t.UTC().Format(time.RFC3339)
}
