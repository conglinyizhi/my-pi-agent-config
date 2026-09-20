package main

import "time"

const protocolVersion = 1

const (
	rolePI      = "pi"
	roleGUI     = "gui"
	roleAdapter = "adapter"
	roleAdmin   = "admin"
)

const (
	typeHello        = "hello"
	typeHelloOK      = "hello-ok"
	typeAsk          = "ask"
	typeAskOK        = "ask-ok"
	typeEvent        = "event"
	typeDecide       = "decide"
	typeDecideOK     = "decide-ok"
	typeSettled      = "settled"
	typeList         = "list"
	typeListOK       = "list-ok"
	typePair         = "pair"
	typePairOK       = "pair-ok"
	typeUnauthorized = "unauthorized"
	typeGrant        = "grant"
	typeGrantOK      = "grant-ok"
	typePairs        = "pairs"
	typePairsOK      = "pairs-ok"
	typeOpenAllow    = "open-allow"
	typeOpenAllowOK  = "open-allow-ok"
	typeAbort        = "abort"
	typeError        = "error"
)

const (
	settleDecided = "decided"
	settleExpired = "expired"
	settleAborted = "aborted"
)

const (
	byGUI     = "gui"
	byAdapter = "adapter"
	byTimeout = "timeout"
	byAbort   = "abort"
	byAdmin   = "admin"
)

// Envelope 是 Unix socket 上的一行 JSON。未知字段忽略。
type Envelope struct {
	V           int            `json:"v"`
	Type        string         `json:"type"`
	ID          string         `json:"id,omitempty"`
	Role        string         `json:"role,omitempty"`
	SessionID   string         `json:"sessionId,omitempty"`
	RequestID   string         `json:"requestId,omitempty"`
	Kind        string         `json:"kind,omitempty"`
	Payload     map[string]any `json:"payload,omitempty"`
	TimeoutMs   int64          `json:"timeoutMs,omitempty"`
	Action      string         `json:"action,omitempty"`
	Comment     string         `json:"comment,omitempty"`
	PathActions []PathAction   `json:"pathActions,omitempty"`
	// Answers 是提问类审批的结构化应答。hub 不解释其中含义，只原样透传：
	// 解析规则只有发起方和适配器知道，hub 中途插一道转换，两边就对不上了。
	Answers     []Answer   `json:"answers,omitempty"`
	Principal   *Principal `json:"principal,omitempty"`
	Channel     string     `json:"channel,omitempty"`
	UserID      string     `json:"userId,omitempty"`
	DisplayName string     `json:"displayName,omitempty"`
	Code        string     `json:"code,omitempty"`
	Event       string     `json:"event,omitempty"`
	Reason      string     `json:"reason,omitempty"`
	By          string     `json:"by,omitempty"`
	ExpiresAt   string     `json:"expiresAt,omitempty"`
	Message     string     `json:"message,omitempty"`
	// Adapters 只在 ask-ok 里回填，让 pi 知道此刻有几个适配器接单：
	// 一个都没有就得立刻回退本地 TUI，等适配器稍后自己连上就晚了。
	Adapters int        `json:"adapters,omitempty"`
	Items    []ListItem `json:"items,omitempty"`
	Pairs    []PairItem `json:"pairs,omitempty"`
	// NoLocalGUI 由发起方声明：这条 ask 不上本机闸门窗。
	// hub 不认 kind，所以不能自己判断「提问不该弹窗」——那是发起方才知道的事，
	// 交给 hub 猜的话，本机窗只会弹出一个没有对应形态的空表。
	NoLocalGUI bool `json:"noLocalGui,omitempty"`
	// Principals 是随审批事件下发的当前授权名单，适配器据此决定审批卡推给谁。
	// 不能只靠适配器自己见过的 chat：它一重启那张表就空了，卡会静默地推不出去。
	Principals []Principal `json:"principals,omitempty"`
	PeerUID    uint32      `json:"peerUid,omitempty"`
}

// Answer 是提问审批的一条应答。样式由发起方给，用户填了什么由适配器带回，
// hub 不认 id，也不认 value 的取值空间。
type Answer struct {
	ID        string `json:"id"`
	Value     string `json:"value"`
	Label     string `json:"label"`
	WasCustom bool   `json:"wasCustom,omitempty"`
}

type PathAction struct {
	Path string `json:"path"`
	List string `json:"list"`
}

type Principal struct {
	Channel     string `json:"channel"`
	UserID      string `json:"userId"`
	DisplayName string `json:"displayName,omitempty"`
	GrantedAt   string `json:"grantedAt,omitempty"`
}

func (p Principal) key() string {
	return p.Channel + "\x1f" + p.UserID
}

type ListItem struct {
	RequestID string `json:"requestId"`
	SessionID string `json:"sessionId,omitempty"`
	Kind      string `json:"kind"`
	ExpiresAt string `json:"expiresAt"`
	Command   string `json:"command,omitempty"`
}

// PairItem 给本机 admin / GUI 看 pending 配对；不发给适配器。
type PairItem struct {
	Code        string `json:"code"`
	Channel     string `json:"channel"`
	UserID      string `json:"userId"`
	DisplayName string `json:"displayName,omitempty"`
	ExpiresAt   string `json:"expiresAt"`
}

func rfc3339(t time.Time) string {
	return t.UTC().Format(time.RFC3339)
}
