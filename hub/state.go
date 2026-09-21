package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const pairingPrefix = "PIHUB-"

var (
	errUnknownAsk      = errors.New("未知审批")
	errAlreadySettled  = errors.New("已经决断")
	errUnauthorized    = errors.New("未授权")
	errUnknownCode     = errors.New("配对码无效或已过期")
	errEmptyPrincipal  = errors.New("缺少身份")
	errInvalidDecision = errors.New("应答无效")
)

type allowFile struct {
	Principals []Principal `json:"principals"`
}

type Pair struct {
	Code      string
	Principal Principal
	ExpiresAt time.Time
}

type Ask struct {
	RequestID string
	SessionID string
	Kind      string
	Payload   map[string]any
	ExpiresAt time.Time
	done      chan struct{}
	decision  *Envelope
}

type Hub struct {
	mu        sync.Mutex
	now       func() time.Time
	askTTL    time.Duration
	pairTTL   time.Duration
	statePath string
	allow     map[string]Principal // key -> principal
	pending   map[string]*Ask
	pairs     map[string]*Pair  // code -> pair
	pairIndex map[string]string // principal key -> code
}

func newHub(statePath string, askTTL, pairTTL time.Duration, now func() time.Time) *Hub {
	if now == nil {
		now = time.Now
	}
	if askTTL <= 0 {
		askTTL = time.Hour
	}
	if pairTTL <= 0 {
		pairTTL = 15 * time.Minute
	}
	h := &Hub{
		now:       now,
		askTTL:    askTTL,
		pairTTL:   pairTTL,
		statePath: statePath,
		allow:     map[string]Principal{},
		pending:   map[string]*Ask{},
		pairs:     map[string]*Pair{},
		pairIndex: map[string]string{},
	}
	h.loadAllow()
	return h
}

func (h *Hub) loadAllow() {
	data, err := os.ReadFile(h.statePath)
	if err != nil {
		return
	}
	var file allowFile
	if json.Unmarshal(data, &file) != nil {
		return
	}
	for _, p := range file.Principals {
		if p.Channel == "" || p.UserID == "" {
			continue
		}
		h.allow[p.key()] = p
	}
}

func (h *Hub) persistAllowLocked() error {
	if h.statePath == "" {
		return nil
	}
	file := allowFile{Principals: make([]Principal, 0, len(h.allow))}
	for _, p := range h.allow {
		file.Principals = append(file.Principals, p)
	}
	data, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(h.statePath)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp := h.statePath + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, h.statePath)
}

func (h *Hub) allowed(p Principal) bool {
	_, ok := h.allow[p.key()]
	return ok
}

// Principals 返回授权名单的快照，供随审批事件下发给适配器。
// 返回的是副本：调用方改它不会动到 hub 的白名单。
func (h *Hub) Principals() []Principal {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]Principal, 0, len(h.allow))
	for _, p := range h.allow {
		out = append(out, p)
	}
	return out
}

func (h *Hub) SubmitAsk(requestID, sessionID, kind string, payload map[string]any, timeout time.Duration) *Ask {
	h.mu.Lock()
	defer h.mu.Unlock()
	if timeout <= 0 {
		timeout = h.askTTL
	}
	ask := &Ask{
		RequestID: requestID,
		SessionID: sessionID,
		Kind:      kind,
		Payload:   payload,
		ExpiresAt: h.now().Add(timeout),
		done:      make(chan struct{}),
	}
	h.pending[requestID] = ask
	return ask
}

func (h *Hub) snapshotAsk(requestID string) *Ask {
	h.mu.Lock()
	defer h.mu.Unlock()
	ask := h.pending[requestID]
	if ask == nil {
		return nil
	}
	copyAsk := *ask
	return &copyAsk
}

func (h *Hub) wait(ask *Ask) *Envelope {
	<-ask.done
	return ask.decision
}

// Decide 定格一次决断。writePaths 是用户在闸门窗里编辑后的执行范围，
// 与 pathActions 一样原样进 settled：hub 不解释内容，也不替 pi 做归一化。
func (h *Hub) Decide(requestID, by string, principal *Principal, action, comment string, pathActions []PathAction, writePaths []string, answers []Answer) (*Envelope, error) {
	if action != "allow" && action != "deny" {
		return nil, errInvalidDecision
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if by == byAdapter {
		if principal == nil || principal.Channel == "" || principal.UserID == "" {
			return nil, errEmptyPrincipal
		}
		if !h.allowed(*principal) {
			return nil, errUnauthorized
		}
	}
	return h.settleLocked(requestID, action, comment, pathActions, writePaths, answers, settleDecided, by)
}

func (h *Hub) Abort(requestID string) (*Envelope, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.settleLocked(requestID, "deny", "", nil, nil, nil, settleAborted, byAbort)
}

func (h *Hub) Expire(requestID string) (*Envelope, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	ask := h.pending[requestID]
	if ask == nil {
		return nil, errUnknownAsk
	}
	if !h.now().Before(ask.ExpiresAt) {
		return h.settleLocked(requestID, "deny", "", nil, nil, nil, settleExpired, byTimeout)
	}
	return nil, nil
}

// settleLocked 把 ask 定格成一份 settled。answers 与 writePaths 只有本人应答的路径才带，
// 超时和 abort 没有用户填过的东西，传 nil。
func (h *Hub) settleLocked(requestID, action, comment string, pathActions []PathAction, writePaths []string, answers []Answer, reason, by string) (*Envelope, error) {
	ask := h.pending[requestID]
	if ask == nil {
		return nil, errUnknownAsk
	}
	select {
	case <-ask.done:
		return nil, errAlreadySettled
	default:
	}
	env := &Envelope{
		V:           protocolVersion,
		Type:        typeSettled,
		RequestID:   requestID,
		SessionID:   ask.SessionID,
		Kind:        ask.Kind,
		Action:      action,
		Comment:     comment,
		PathActions: pathActions,
		WritePaths:  writePaths,
		Answers:     answers,
		Reason:      reason,
		By:          by,
	}
	ask.decision = env
	delete(h.pending, requestID)
	close(ask.done)
	return env, nil
}

func (h *Hub) List() []ListItem {
	h.mu.Lock()
	defer h.mu.Unlock()
	now := h.now()
	items := make([]ListItem, 0, len(h.pending))
	for _, ask := range h.pending {
		if !now.Before(ask.ExpiresAt) {
			continue
		}
		cmd, _ := ask.Payload["command"].(string)
		items = append(items, ListItem{
			RequestID: ask.RequestID,
			SessionID: ask.SessionID,
			Kind:      ask.Kind,
			ExpiresAt: rfc3339(ask.ExpiresAt),
			Command:   cmd,
		})
	}
	return items
}

// Pair 给陌生人发码。已在名单里则 allowed=true、不发新码。
func (h *Hub) Pair(channel, userID, displayName string) (pair *Pair, allowed bool, err error) {
	if channel == "" || userID == "" {
		return nil, false, errEmptyPrincipal
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	p := Principal{Channel: channel, UserID: userID, DisplayName: displayName}
	if h.allowed(p) {
		return nil, true, nil
	}
	if old := h.pairIndex[p.key()]; old != "" {
		delete(h.pairs, old)
	}
	code, err := newPairingCode()
	if err != nil {
		return nil, false, err
	}
	pair = &Pair{
		Code:      code,
		Principal: p,
		ExpiresAt: h.now().Add(h.pairTTL),
	}
	h.pairs[code] = pair
	h.pairIndex[p.key()] = code
	return pair, false, nil
}

func (h *Hub) Grant(code string) (*Principal, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	pair := h.pairs[code]
	if pair == nil || !h.now().Before(pair.ExpiresAt) {
		delete(h.pairs, code)
		return nil, errUnknownCode
	}
	p := pair.Principal
	p.GrantedAt = rfc3339(h.now())
	h.allow[p.key()] = p
	delete(h.pairs, code)
	delete(h.pairIndex, p.key())
	if err := h.persistAllowLocked(); err != nil {
		return nil, err
	}
	return &p, nil
}

func (h *Hub) ListPairs() []PairItem {
	h.mu.Lock()
	defer h.mu.Unlock()
	now := h.now()
	out := make([]PairItem, 0, len(h.pairs))
	for _, pair := range h.pairs {
		if !now.Before(pair.ExpiresAt) {
			continue
		}
		out = append(out, PairItem{
			Code:        pair.Code,
			Channel:     pair.Principal.Channel,
			UserID:      pair.Principal.UserID,
			DisplayName: pair.Principal.DisplayName,
			ExpiresAt:   rfc3339(pair.ExpiresAt),
		})
	}
	return out
}

func (h *Hub) SweepExpiredPairs() {
	h.mu.Lock()
	defer h.mu.Unlock()
	now := h.now()
	for code, pair := range h.pairs {
		if now.Before(pair.ExpiresAt) {
			continue
		}
		delete(h.pairs, code)
		if h.pairIndex[pair.Principal.key()] == code {
			delete(h.pairIndex, pair.Principal.key())
		}
	}
}

func newPairingCode() (string, error) {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return pairingPrefix + hex.EncodeToString(b[:]), nil
}
