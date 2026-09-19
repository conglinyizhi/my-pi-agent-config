package main

import (
	"encoding/json"
	"fmt"
	"net"
	"sync"
	"time"
)

const channelName = "feishu"

type hubClient struct {
	conn     net.Conn
	enc      *json.Encoder
	mu       sync.Mutex
	pending  chan envelope
	onEvent  func(envelope)
	onSettle func(envelope)
}

type envelope struct {
	V           int            `json:"v"`
	Type        string         `json:"type"`
	ID          string         `json:"id,omitempty"`
	Role        string         `json:"role,omitempty"`
	SessionID   string         `json:"sessionId,omitempty"`
	RequestID   string         `json:"requestId,omitempty"`
	Kind        string         `json:"kind,omitempty"`
	Payload     map[string]any `json:"payload,omitempty"`
	Action      string         `json:"action,omitempty"`
	Comment     string         `json:"comment,omitempty"`
	Principal   *principal     `json:"principal,omitempty"`
	Channel     string         `json:"channel,omitempty"`
	UserID      string         `json:"userId,omitempty"`
	DisplayName string         `json:"displayName,omitempty"`
	Code        string         `json:"code,omitempty"`
	Event       string         `json:"event,omitempty"`
	Reason      string         `json:"reason,omitempty"`
	By          string         `json:"by,omitempty"`
	ExpiresAt   string         `json:"expiresAt,omitempty"`
	Message     string         `json:"message,omitempty"`
	Items       []listItem     `json:"items,omitempty"`
}

type principal struct {
	Channel     string `json:"channel"`
	UserID      string `json:"userId"`
	DisplayName string `json:"displayName,omitempty"`
}

type listItem struct {
	RequestID string `json:"requestId"`
	SessionID string `json:"sessionId,omitempty"`
	Kind      string `json:"kind"`
	ExpiresAt string `json:"expiresAt"`
	Command   string `json:"command,omitempty"`
}

func dialHub(socketPath string) (*hubClient, error) {
	conn, err := net.DialTimeout("unix", socketPath, 2*time.Second)
	if err != nil {
		return nil, err
	}
	h := &hubClient{
		conn:    conn,
		enc:     json.NewEncoder(conn),
		pending: make(chan envelope, 8),
	}
	if err := h.write(envelope{V: 1, Type: "hello", Role: "adapter"}); err != nil {
		conn.Close()
		return nil, err
	}
	dec := json.NewDecoder(conn)
	var hello envelope
	if err := dec.Decode(&hello); err != nil {
		conn.Close()
		return nil, err
	}
	if hello.Type != "hello-ok" {
		conn.Close()
		return nil, fmt.Errorf("hub hello 失败: %s", hello.Message)
	}
	go h.readLoop(dec)
	return h, nil
}

func (h *hubClient) write(env envelope) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	env.V = 1
	return h.enc.Encode(env)
}

func (h *hubClient) readLoop(dec *json.Decoder) {
	for {
		var env envelope
		if err := dec.Decode(&env); err != nil {
			close(h.pending)
			return
		}
		switch env.Type {
		case "event":
			if h.onEvent != nil {
				h.onEvent(env)
			}
		case "settled":
			if h.onSettle != nil {
				h.onSettle(env)
			}
		default:
			select {
			case h.pending <- env:
			default:
			}
		}
	}
}

func (h *hubClient) rpc(req envelope) (envelope, error) {
	if err := h.write(req); err != nil {
		return envelope{}, err
	}
	select {
	case out, ok := <-h.pending:
		if !ok {
			return envelope{}, fmt.Errorf("hub 连接已关")
		}
		return out, nil
	case <-time.After(8 * time.Second):
		return envelope{}, fmt.Errorf("hub 响应超时")
	}
}

func (h *hubClient) pair(userID, displayName string) (envelope, error) {
	return h.rpc(envelope{
		Type: "pair", Channel: channelName, UserID: userID, DisplayName: displayName,
	})
}

func (h *hubClient) decide(requestID, action, comment, userID, displayName string) (envelope, error) {
	return h.rpc(envelope{
		Type:      "decide",
		RequestID: requestID,
		Action:    action,
		Comment:   comment,
		Principal: &principal{Channel: channelName, UserID: userID, DisplayName: displayName},
	})
}

func (h *hubClient) list(userID, displayName string) (envelope, error) {
	return h.rpc(envelope{
		Type:      "list",
		Principal: &principal{Channel: channelName, UserID: userID, DisplayName: displayName},
	})
}

func (h *hubClient) close() {
	_ = h.conn.Close()
}

func commandOf(payload map[string]any) string {
	if payload == nil {
		return ""
	}
	s, _ := payload["command"].(string)
	return s
}
