package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"os"
	"sync"
	"time"
)

var (
	errNotUnix     = errors.New("不是 Unix socket")
	errBadHello    = errors.New("hello 无效")
	errPeerUID     = errors.New("对端 UID 不匹配")
	errUnknownType = errors.New("未知消息")
)

type client struct {
	conn net.Conn
	role string
	enc  *json.Encoder
	mu   sync.Mutex
	asks []string
}

func (c *client) send(env Envelope) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	env.V = protocolVersion
	return c.enc.Encode(env)
}

type Server struct {
	hub            *Hub
	socketPath     string
	ourUID         uint32
	skipPeer       bool
	launchGUI      func(ask *Ask)
	killGUI        func(requestID string)
	launchAllowGUI func(pairs []PairItem, asks []ListItem)
	// input 是存在性信号的状态。newServer 先给一个空实例，让没有输入设备的环境
	// （测试、非 Linux）照样能应答 presence；真读设备的循环由 main 起。
	input *inputTracker

	mu      sync.Mutex
	clients map[*client]struct{}
	ln      net.Listener
}

func newServer(hub *Hub, socketPath string, opts ...func(*Server)) *Server {
	s := &Server{
		hub:        hub,
		socketPath: socketPath,
		ourUID:     uint32(os.Getuid()),
		clients:    map[*client]struct{}{},
		input:      newInputTracker(nil),
	}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// launchGateGUI 把本机闸门窗接到 hub 的决断路径上。main 与测试共用这一段接线：
// 各自写一份的话，测的就只是测试里那份拷贝，真接线错了看不出来。
func (s *Server) launchGateGUI(bin string) {
	gui := newGUILauncher(bin)
	s.launchGUI = func(ask *Ask) {
		gui.launch(ask, func(action, comment string, pa []PathAction, writePaths []string) {
			settled, err := s.hub.Decide(ask.RequestID, byGUI, nil, action, comment, pa, writePaths, nil)
			if err == nil {
				s.onSettled(settled)
			}
		})
	}
	s.killGUI = gui.kill
}

func (s *Server) Listen() error {
	if err := os.Remove(s.socketPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	ln, err := net.Listen("unix", s.socketPath)
	if err != nil {
		return err
	}
	if err := os.Chmod(s.socketPath, 0o600); err != nil {
		ln.Close()
		return err
	}
	s.ln = ln
	return nil
}

func (s *Server) Serve() error {
	for {
		conn, err := s.ln.Accept()
		if err != nil {
			return err
		}
		go s.handle(conn)
	}
}

func (s *Server) Close() error {
	if s.ln != nil {
		return s.ln.Close()
	}
	return nil
}

func (s *Server) remove(c *client) {
	s.mu.Lock()
	delete(s.clients, c)
	s.mu.Unlock()
}

// adapterCount 数当前在线的适配器。pi 拿这个数决定要不要立刻回退本地 TUI：
// 没有适配器还硬等，用户就只看到一条不动的审批。
func (s *Server) adapterCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for c := range s.clients {
		if c.role == roleAdapter {
			n++
		}
	}
	return n
}

// greet 回 hello-ok，并且整段握着 clients 锁。
//
// 入册必须在回 hello-ok 之前：对端看到 hello-ok 就认为自己在册，若入册晚一步，
// 恰好此刻扇出的 ask 事件会整条漏掉（适配器那边表现为卡没来）。
// 但入册之后广播就可能抢写，对端先收到 event 再收到 hello-ok，它的 hello 校验
// 会直接失败（表现为「连不上 hub」）。两个窗口一起关：入册与回 hello-ok 同一把锁。
func (s *Server) greet(c *client) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.clients[c] = struct{}{}
	return c.send(Envelope{Type: typeHelloOK, Role: c.role, PeerUID: s.ourUID})
}

func (s *Server) broadcast(env Envelope, roles ...string) {
	allow := map[string]bool{}
	for _, r := range roles {
		allow[r] = true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for c := range s.clients {
		if allow[c.role] {
			_ = c.send(env)
		}
	}
}

func (s *Server) handle(conn net.Conn) {
	defer conn.Close()
	if !s.skipPeer {
		uid, err := peerUID(conn)
		if err != nil || uid != s.ourUID {
			_ = json.NewEncoder(conn).Encode(Envelope{V: protocolVersion, Type: typeError, Message: errPeerUID.Error()})
			return
		}
	}
	br := bufio.NewReader(conn)
	dec := json.NewDecoder(br)
	enc := json.NewEncoder(conn)
	var hello Envelope
	if err := dec.Decode(&hello); err != nil {
		return
	}
	if hello.Type != typeHello || !validRole(hello.Role) {
		_ = enc.Encode(Envelope{V: protocolVersion, Type: typeError, Message: errBadHello.Error()})
		return
	}
	c := &client{conn: conn, role: hello.Role, enc: enc}
	defer func() {
		s.remove(c)
		if c.role == rolePI {
			for _, id := range c.asks {
				if _, err := s.hub.Abort(id); err == nil {
					s.onSettled(&Envelope{
						Type: typeSettled, RequestID: id, Action: "deny",
						Reason: settleAborted, By: byAbort,
					})
				}
			}
		}
	}()
	if err := s.greet(c); err != nil {
		return
	}

	for {
		var env Envelope
		if err := dec.Decode(&env); err != nil {
			return
		}
		if err := s.dispatch(c, env); err != nil {
			_ = c.send(Envelope{Type: typeError, ID: env.ID, Message: err.Error()})
		}
	}
}

func validRole(role string) bool {
	switch role {
	case rolePI, roleGUI, roleAdapter, roleAdmin:
		return true
	default:
		return false
	}
}

func (s *Server) dispatch(c *client, env Envelope) error {
	switch env.Type {
	case typeAsk:
		if c.role != rolePI {
			return errUnknownType
		}
		return s.onAsk(c, env)
	case typeAbort:
		if c.role != rolePI && c.role != roleAdmin {
			return errUnknownType
		}
		_, err := s.hub.Abort(env.RequestID)
		if err != nil {
			return err
		}
		s.onSettled(&Envelope{
			Type: typeSettled, RequestID: env.RequestID, Action: "deny",
			Reason: settleAborted, By: byAbort,
		})
		return nil
	case typeDecide:
		if c.role != roleAdapter && c.role != roleGUI && c.role != roleAdmin {
			return errUnknownType
		}
		by := byAdapter
		if c.role == roleGUI {
			by = byGUI
		} else if c.role == roleAdmin {
			by = byAdmin
		}
		settled, err := s.hub.Decide(env.RequestID, by, env.Principal, env.Action, env.Comment, env.PathActions, env.WritePaths, env.Answers)
		if err != nil {
			return err
		}
		// 回执发给发起方：适配器那边是按 RPC 等的，没有回执就要干等到 8 秒超时，
		// 期间它那条事件读循环还被占着。注意不能拿 settled 当回执——适配器把
		// type=settled 当事件处理，收不到 pending 里。
		if err := c.send(Envelope{Type: typeDecideOK, ID: env.ID, RequestID: env.RequestID, Action: env.Action}); err != nil {
			return err
		}
		s.onSettled(settled)
		return nil
	case typeList:
		if c.role != roleAdapter && c.role != roleAdmin && c.role != roleGUI {
			return errUnknownType
		}
		if c.role == roleAdapter {
			if env.Principal == nil || !s.hub.allowed(*env.Principal) {
				return errUnauthorized
			}
		}
		return c.send(Envelope{Type: typeListOK, ID: env.ID, Items: s.hub.List()})
	case typePair:
		if c.role != roleAdapter {
			return errUnknownType
		}
		pair, allowed, err := s.hub.Pair(env.Channel, env.UserID, env.DisplayName)
		if err != nil {
			return err
		}
		out := Envelope{Type: typePairOK, ID: env.ID, Channel: env.Channel, UserID: env.UserID}
		if allowed {
			return c.send(out)
		}
		out.Type = typeUnauthorized
		out.Code = pair.Code
		out.ExpiresAt = rfc3339(pair.ExpiresAt)
		out.Message = "当前账号未授权，请等待核心授权。若你就是机主，把下面这段复制给核心。"
		return c.send(out)
	case typeGrant:
		if c.role != roleAdmin && c.role != roleGUI {
			return errUnknownType
		}
		p, err := s.hub.Grant(env.Code)
		if err != nil {
			return err
		}
		return c.send(Envelope{Type: typeGrantOK, ID: env.ID, Principal: p})
	case typePairs:
		if c.role != roleAdmin && c.role != roleGUI {
			return errUnknownType
		}
		return c.send(Envelope{Type: typePairsOK, ID: env.ID, Pairs: s.hub.ListPairs()})
	case typeOpenAllow:
		if c.role != roleAdmin && c.role != rolePI {
			return errUnknownType
		}
		if s.launchAllowGUI == nil {
			return errors.New("未找到 yad，无法打开许可窗")
		}
		go s.launchAllowGUI(s.hub.ListPairs(), s.hub.List())
		return c.send(Envelope{Type: typeOpenAllowOK, ID: env.ID})
	case typePresence:
		// 只有适配器问这个：它决定审批卡是立刻推还是先攒着。
		// 本机闸门窗不需要，它已经在用户眼前了。
		if c.role != roleAdapter {
			return errUnknownType
		}
		idle, hasInput := s.input.Idle()
		idleMs := idle.Milliseconds()
		return c.send(Envelope{
			Type:     typePresenceOK,
			ID:       env.ID,
			IdleMs:   &idleMs,
			HasInput: &hasInput,
		})
	default:
		return errUnknownType
	}
}

func (s *Server) onAsk(c *client, env Envelope) error {
	requestID := env.RequestID
	if requestID == "" {
		requestID = newID("ask")
	}
	timeout := time.Duration(env.TimeoutMs) * time.Millisecond
	payload := env.Payload
	if payload == nil {
		payload = map[string]any{}
	}
	if env.Kind != "" {
		payload["kind"] = env.Kind
	}
	if env.SessionID != "" {
		payload["sessionId"] = env.SessionID
	}
	ask := s.hub.SubmitAsk(requestID, env.SessionID, env.Kind, payload, timeout)
	c.asks = append(c.asks, requestID)
	if err := c.send(Envelope{
		Type: typeAskOK, ID: env.ID, RequestID: requestID,
		ExpiresAt: rfc3339(ask.ExpiresAt), Adapters: s.adapterCount(),
	}); err != nil {
		return err
	}
	s.broadcast(Envelope{
		Type:       typeEvent,
		Event:      "ask",
		RequestID:  requestID,
		SessionID:  env.SessionID,
		Kind:       env.Kind,
		Payload:    payload,
		ExpiresAt:  rfc3339(ask.ExpiresAt),
		Principals: s.hub.Principals(),
	}, roleAdapter, roleGUI, roleAdmin)
	// 发起方声明了不上本机窗就不拉：本机闸门窗只有审批形态，
	// 换成提问这种没有对应版式的请求，弹出来就是一张读不懂的空表
	if s.launchGUI != nil && !env.NoLocalGUI {
		go s.launchGUI(ask)
	}
	go func() {
		settled := s.hub.wait(ask)
		if settled != nil {
			_ = c.send(*settled)
		}
	}()
	return nil
}

func (s *Server) onSettled(env *Envelope) {
	if env == nil {
		return
	}
	if s.killGUI != nil {
		s.killGUI(env.RequestID)
	}
	s.broadcast(*env, roleAdapter, roleGUI, roleAdmin)
}

func (s *Server) tick() {
	s.hub.SweepExpiredPairs()
	for _, item := range s.hub.List() {
		_ = item
	}
	// List 会跳过已过期项，过期结算要扫 pending 副本
	s.expireDue()
}

func (s *Server) expireDue() {
	s.hub.mu.Lock()
	ids := make([]string, 0, len(s.hub.pending))
	now := s.hub.now()
	for id, ask := range s.hub.pending {
		if !now.Before(ask.ExpiresAt) {
			ids = append(ids, id)
		}
	}
	s.hub.mu.Unlock()
	for _, id := range ids {
		env, err := s.hub.Expire(id)
		if err == nil && env != nil {
			s.onSettled(env)
		}
	}
}

func newID(prefix string) string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return prefix + "-" + hex.EncodeToString(b[:])
}
