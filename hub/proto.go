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
	Principal   *Principal     `json:"principal,omitempty"`
	Channel     string         `json:"channel,omitempty"`
	UserID      string         `json:"userId,omitempty"`
	DisplayName string         `json:"displayName,omitempty"`
	Code        string         `json:"code,omitempty"`
	Event       string         `json:"event,omitempty"`
	Reason      string         `json:"reason,omitempty"`
	By          string         `json:"by,omitempty"`
	ExpiresAt   string         `json:"expiresAt,omitempty"`
	Message     string         `json:"message,omitempty"`
	Items       []ListItem     `json:"items,omitempty"`
	Pairs       []PairItem     `json:"pairs,omitempty"`
	PeerUID     uint32         `json:"peerUid,omitempty"`
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
