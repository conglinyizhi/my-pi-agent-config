package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"log"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"
)

var (
	errNotUnix     = errors.New("不是 Unix socket")
	errBadHello    = errors.New("hello 无效")
	errPeerUID     = errors.New("对端 UID 不匹配")
	errUnknownType = errors.New("未知消息")
)

// sendTimeout 是一次写 socket 的上限。守护发 arrived / finish 时握着连接锁，
// 对端不读就会一直等；等到写超时当连接已死处理，比整条守护被一个僵住的 pi 拖住划算。
const sendTimeout = 5 * time.Second

type client struct {
	conn net.Conn
	enc  *json.Encoder
	mu   sync.Mutex
}

func (c *client) send(env Envelope) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	env.V = protocolVersion
	_ = c.conn.SetWriteDeadline(time.Now().Add(sendTimeout))
	return c.enc.Encode(env)
}

// holderState 是锁的持有者。lastSeen 由 ping 刷新，判假死只看它：
// 连接还在但进程冻住时，TCP 层不会给任何提示，只能靠心跳。
type holderState struct {
	c         *client
	sessionID string
	name      string
	since     time.Time
	lastSeen  time.Time
}

type Server struct {
	st         *Store
	socketPath string
	ourUID     uint32
	stale      time.Duration
	// webAddr 是 HTTP 实际监听的地址，url 消息据此拼出手机能打开的地址。
	webAddr string

	mu      sync.Mutex
	clients map[*client]struct{}
	holder  *holderState
	// pushed 是当前 holder 任期内推出去的张数，finish 事件带它回去。
	pushed int

	// pumpMu 串起「取未推项 → 发送 → 标记」这一串，
	// 不加的话 attach 的 flush 和 upload 的直推会同时把同一张图发两遍。
	pumpMu sync.Mutex
	ln     net.Listener
}

func newServer(st *Store, socketPath string, stale time.Duration) *Server {
	if stale <= 0 {
		stale = 30 * time.Second
	}
	return &Server{
		st:         st,
		socketPath: socketPath,
		ourUID:     uint32(os.Getuid()),
		stale:      stale,
		clients:    map[*client]struct{}{},
	}
}

func (s *Server) Listen() error {
	if err := os.MkdirAll(filepath.Dir(s.socketPath), 0o700); err != nil {
		return err
	}
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

func (s *Server) handle(conn net.Conn) {
	defer conn.Close()
	uid, err := peerUID(conn)
	if err != nil || uid != s.ourUID {
		_ = json.NewEncoder(conn).Encode(Envelope{V: protocolVersion, Type: typeError, Message: errPeerUID.Error()})
		return
	}
	c := &client{conn: conn, enc: json.NewEncoder(conn)}
	dec := json.NewDecoder(bufio.NewReader(conn))
	var hello Envelope
	if err := dec.Decode(&hello); err != nil {
		return
	}
	if hello.Type != typeHello || hello.Role != rolePI {
		_ = c.send(Envelope{Type: typeError, Message: errBadHello.Error()})
		return
	}
	s.add(c)
	// 断连即释锁：锁绑定在连接上，不是绑定在一条 detach 消息上。
	// pi 崩了、被 kill 了都来不及发 detach，靠消息释放就只能等心跳超期。
	defer func() {
		s.remove(c)
		s.release(c)
	}()
	if err := c.send(Envelope{Type: typeHelloOK, PeerUID: s.ourUID}); err != nil {
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

func (s *Server) add(c *client) {
	s.mu.Lock()
	s.clients[c] = struct{}{}
	s.mu.Unlock()
}

func (s *Server) remove(c *client) {
	s.mu.Lock()
	delete(s.clients, c)
	s.mu.Unlock()
}

func (s *Server) dispatch(c *client, env Envelope) error {
	switch env.Type {
	case typeAttach:
		return s.onAttach(c, env)
	case typeDetach:
		s.release(c)
		return c.send(Envelope{Type: typeDetachOK, ID: env.ID})
	case typePing:
		s.touch(c)
		return c.send(Envelope{Type: typePong, ID: env.ID})
	case typeAck:
		// 不要求 ack 来自 holder：被抢占前已经收到图的那一任，它的 ack 仍然有效，
		// 拒掉的话这些图会永远留在 queue 里等一个不会再来的持有者。
		moved, err := s.st.Ack(env.IDs)
		if err != nil {
			return err
		}
		return c.send(Envelope{Type: typeAckOK, ID: env.ID, Moved: num(moved)})
	case typeURL:
		return c.send(Envelope{Type: typeURLOK, ID: env.ID, URL: s.webURL()})
	default:
		return errUnknownType
	}
}

func (s *Server) onAttach(c *client, env Envelope) error {
	now := time.Now()
	s.mu.Lock()
	if s.holder != nil && s.holder.c == c {
		// 同一条连接重复 attach（pi 换会话名之类）：幂等更新，不必重发一遍图
		s.holder.sessionID = env.SessionID
		s.holder.name = env.Name
		s.holder.lastSeen = now
		s.mu.Unlock()
		return c.send(Envelope{Type: typeAttachOK, ID: env.ID, Queued: num(s.st.Queued())})
	}
	if s.holder != nil {
		h := s.holder
		reason := ""
		switch {
		case env.Force:
			reason = reasonForced
		case now.Sub(h.lastSeen) > s.stale:
			reason = reasonStale
		}
		if reason == "" {
			info := &HolderInfo{SessionID: h.sessionID, Name: h.name, Since: rfc3339(h.since)}
			s.mu.Unlock()
			return c.send(Envelope{Type: typeBusy, ID: env.ID, Holder: info})
		}
		old := h.c
		s.holder = &holderState{c: c, sessionID: env.SessionID, name: env.Name, since: now, lastSeen: now}
		s.pushed = 0
		s.mu.Unlock()
		// 先换锁、再通知旧连接：关连接会触发旧连接的清理路径，
		// 那时它已经不是 holder，不会把刚给新人的锁顺手释放掉。
		// 放 goroutine 里是因为对端不读时 send 要等满写超时，不能拖住新人拿锁。
		go preempt(old, reason)
		return s.granted(c, env)
	}
	s.holder = &holderState{c: c, sessionID: env.SessionID, name: env.Name, since: now, lastSeen: now}
	s.pushed = 0
	s.mu.Unlock()
	return s.granted(c, env)
}

// granted 是新 holder 拿到锁之后的公共收尾：把队列整段重算成未投、回 attach-ok、
// 再把积压推出去。回执必须先发：pi 那边见到 attach-ok 才算锁到手，
// 先推 arrived 的话它收到一屏没有归属的图。
func (s *Server) granted(c *client, env Envelope) error {
	s.st.ResetPushed()
	queued := s.st.Queued()
	if err := c.send(Envelope{Type: typeAttachOK, ID: env.ID, Queued: num(queued)}); err != nil {
		return err
	}
	s.pump()
	return nil
}

// release 只在释放的是当前 holder 时动手：旧 holder 被抢占后连接才关闭，
// 它那条清理路径不能把别人的锁释放掉。
func (s *Server) release(c *client) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.holder != nil && s.holder.c == c {
		s.holder = nil
		s.pushed = 0
	}
}

func (s *Server) touch(c *client) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.holder != nil && s.holder.c == c {
		s.holder.lastSeen = time.Now()
	}
}

// sweepStale 主动清理假死的 holder。attach 时也会判一次，但那要等到有人来抢；
// 没有新人来的话，锁会一直挂在一条没人读的连接上，页面也就一直显示有人在收。
func (s *Server) sweepStale(now time.Time) bool {
	s.mu.Lock()
	h := s.holder
	if h == nil || now.Sub(h.lastSeen) <= s.stale {
		s.mu.Unlock()
		return false
	}
	old := h.c
	s.holder = nil
	s.pushed = 0
	s.mu.Unlock()
	go preempt(old, reasonStale)
	return true
}

// preempt 通知旧 holder 被抢，然后关掉它。
func preempt(old *client, reason string) {
	_ = old.send(Envelope{Type: typePreempted, Reason: reason})
	_ = old.conn.Close()
}

// pump 把队列里还没推给当前 holder 的项推出去，返回实际推的张数。
func (s *Server) pump() int {
	s.pumpMu.Lock()
	defer s.pumpMu.Unlock()
	s.mu.Lock()
	h := s.holder
	s.mu.Unlock()
	if h == nil {
		return 0
	}
	items := s.st.Unpushed()
	if len(items) == 0 {
		return 0
	}
	out := make([]Item, 0, len(items))
	ids := make([]string, 0, len(items))
	for _, it := range items {
		out = append(out, it.item())
		ids = append(ids, it.ID)
	}
	if err := h.c.send(Envelope{Type: typeArrived, Items: out}); err != nil {
		// 没发出去就不标记：图还在 queue 里，下一个 holder 接手时还得推它
		log.Printf("推送 arrived 失败，%d 张留在队列: %v", len(items), err)
		return 0
	}
	s.st.MarkPushed(ids)
	s.mu.Lock()
	if s.holder == h {
		s.pushed += len(items)
	}
	s.mu.Unlock()
	return len(items)
}

// finishByWeb 处理页面上的「结束」：给 holder 发 finish 并释放锁。
// count 是这一任 holder 任期内推出去的张数；连接不关，pi 想再 attach 就再 attach。
func (s *Server) finishByWeb() int {
	s.mu.Lock()
	h := s.holder
	count := s.pushed
	s.holder = nil
	s.pushed = 0
	s.mu.Unlock()
	if h != nil {
		_ = h.c.send(Envelope{Type: typeFinish, By: byWeb, Count: num(count)})
	}
	return count
}

// listenerInfo 是 /status 里的 listener 字段，同时也是给 pi 看的锁快照。
type listenerInfo struct {
	SessionID string `json:"sessionId"`
	Name      string `json:"name"`
	Since     string `json:"since"`
}

func (s *Server) listener() *listenerInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.holder == nil {
		return nil
	}
	return &listenerInfo{
		SessionID: s.holder.sessionID,
		Name:      s.holder.name,
		Since:     rfc3339(s.holder.since),
	}
}

// tick 由定时器驱动：清假死 holder，顺便重推一次没推成功的积压。
func (s *Server) tick(now time.Time) {
	s.sweepStale(now)
	s.pump()
}
