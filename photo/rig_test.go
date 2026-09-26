package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// rig 是一套完整的测试装置：临时 state 目录、临时 socket、httptest 上的 HTTP。
// HTTP 端口由 httptest 随机分配，不碰真实端口，也不碰用户的 ~/.pi。
type rig struct {
	t   *testing.T
	st  *Store
	srv *Server
	ts  *httptest.Server
}

func newRig(t *testing.T) *rig {
	t.Helper()
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	sock := filepath.Join(t.TempDir(), "photo.sock")
	srv := newServer(st, sock, 30*time.Second)
	srv.webAddr = "192.168.1.20:8787"
	if err := srv.Listen(); err != nil {
		t.Fatal(err)
	}
	go func() { _ = srv.Serve() }()
	ts := httptest.NewServer(srv.handler())
	r := &rig{t: t, st: st, srv: srv, ts: ts}
	t.Cleanup(func() {
		ts.Close()
		_ = srv.Close()
	})
	return r
}

func (r *rig) token() string { return r.st.Token() }

func (r *rig) url(path string) string {
	return r.ts.URL + path + "?k=" + r.token()
}

func (r *rig) get(path, key string) (*http.Response, []byte) {
	r.t.Helper()
	resp, err := http.Get(r.ts.URL + path + "?k=" + key)
	if err != nil {
		r.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, b
}

func (r *rig) post(path, key string, body any) (*http.Response, []byte) {
	r.t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			r.t.Fatal(err)
		}
	}
	resp, err := http.Post(r.ts.URL+path+"?k="+key, "application/json", &buf)
	if err != nil {
		r.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, b
}

// upload 走真实 HTTP 上传，回一个解好的 JSON。
func (r *rig) upload(imgs ...uploadImage) map[string]any {
	r.t.Helper()
	resp, body := r.post("/upload", r.token(), uploadReq{Images: imgs})
	if resp.StatusCode != http.StatusOK {
		r.t.Fatalf("upload 状态码 %d: %s", resp.StatusCode, body)
	}
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		r.t.Fatalf("upload 回执不是 JSON: %v (%s)", err, body)
	}
	return out
}

func (r *rig) status() (listener map[string]any, queued, delivered int) {
	r.t.Helper()
	resp, body := r.get("/status", r.token())
	if resp.StatusCode != http.StatusOK {
		r.t.Fatalf("status 状态码 %d: %s", resp.StatusCode, body)
	}
	var out struct {
		Listener  map[string]any `json:"listener"`
		Queued    int            `json:"queued"`
		Delivered int            `json:"delivered"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		r.t.Fatalf("status 不是 JSON: %v (%s)", err, body)
	}
	return out.Listener, out.Queued, out.Delivered
}

func (r *rig) finish() map[string]any {
	r.t.Helper()
	resp, body := r.post("/finish", r.token(), nil)
	if resp.StatusCode != http.StatusOK {
		r.t.Fatalf("finish 状态码 %d: %s", resp.StatusCode, body)
	}
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		r.t.Fatalf("finish 回执不是 JSON: %v (%s)", err, body)
	}
	return out
}

func jpegImage(name string, n int) uploadImage {
	return uploadImage{Name: name, DataURL: jpegDataURL(n)}
}

func jpegDataURL(n int) string {
	data := make([]byte, 0, n+3)
	data = append(data, 0xff, 0xd8, 0xff)
	for len(data) < n {
		data = append(data, 0xe0)
	}
	return "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(data[:n])
}

// ---- socket 侧的测试客户端 ----

type piConn struct {
	conn net.Conn
	dec  *json.Decoder
	enc  *json.Encoder
}

func (r *rig) dial() *piConn {
	r.t.Helper()
	conn, err := net.Dial("unix", r.srv.socketPath)
	if err != nil {
		r.t.Fatal(err)
	}
	c := &piConn{conn: conn, dec: json.NewDecoder(conn), enc: json.NewEncoder(conn)}
	c.send(r.t, Envelope{Type: typeHello, Role: rolePI})
	if env := c.recv(r.t); env.Type != typeHelloOK {
		r.t.Fatalf("hello 之后应当收 hello-ok，实际 %+v", env)
	}
	return c
}

// dialRaw 只连上来，不打招呼，用来测 hello 校验这条路径。
func dialRaw(socketPath string) (*piConn, error) {
	conn, err := net.Dial("unix", socketPath)
	if err != nil {
		return nil, err
	}
	return &piConn{conn: conn, dec: json.NewDecoder(conn), enc: json.NewEncoder(conn)}, nil
}

func (r *rig) attach(sessionID, name string, force bool) (*piConn, Envelope) {
	r.t.Helper()
	c := r.dial()
	c.send(r.t, Envelope{Type: typeAttach, SessionID: sessionID, Name: name, Force: force})
	return c, c.recv(r.t)
}

func (c *piConn) send(t *testing.T, env Envelope) {
	t.Helper()
	if err := c.enc.Encode(env); err != nil {
		t.Fatalf("发送 %s 失败: %v", env.Type, err)
	}
}

func (c *piConn) recv(t *testing.T) Envelope {
	t.Helper()
	_ = c.conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	var env Envelope
	if err := c.dec.Decode(&env); err != nil {
		t.Fatalf("读消息失败: %v", err)
	}
	return env
}

// recvNone 断言这段时间内连接上再没有消息（或已关闭）。
//
// 这里绕开 json.Decoder 直接读一个字节：Decode 撞上读超时之后不会再恢复，
// 后面那条本该读到的消息会被这次超时连带吃掉（实测如此），
// 而「确认没有消息」本来也不需要走解码器。
func (c *piConn) recvNone(t *testing.T, d time.Duration) {
	t.Helper()
	_ = c.conn.SetReadDeadline(time.Now().Add(d))
	buf := make([]byte, 1)
	if n, err := c.conn.Read(buf); err == nil && n > 0 {
		t.Fatalf("不该再收到消息，实际读到 %q", buf[:n])
	}
}

func (c *piConn) close() { _ = c.conn.Close() }

// numOf 读指针整数字段：nil 与 0 在断言里等价，测试不该因为字段缺失就 panic。
func numOf(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}

func waitFor(t *testing.T, d time.Duration, cond func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("等待超时: %s", msg)
}

func mustStat(t *testing.T, path string) os.FileInfo {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	return info
}
