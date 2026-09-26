package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func (r *rig) attachOn(c *piConn, sessionID, name string, force bool) Envelope {
	r.t.Helper()
	c.send(r.t, Envelope{Type: typeAttach, SessionID: sessionID, Name: name, Force: force})
	return c.recv(r.t)
}

// 没人接单时上传必须落盘入队；attach 之后整批推给新 holder。
func TestUploadQueuedThenFlushedOnAttach(t *testing.T) {
	r := newRig(t)
	out := r.upload(jpegImage("a.jpg", 128), jpegImage("b.jpg", 256))
	if out["accepted"] != float64(2) || out["delivered"] != float64(0) || out["queued"] != float64(2) {
		t.Fatalf("无 holder 时上传回执不对: %+v", out)
	}
	if r.st.Queued() != 2 {
		t.Fatalf("图没落盘入队，队列 %d", r.st.Queued())
	}
	ents, err := os.ReadDir(r.st.queueDir())
	if err != nil || len(ents) != 2 {
		t.Fatalf("queue 目录里应当有两张图: %v %d", err, len(ents))
	}

	c, env := r.attach("s1", "pi-main", false)
	if env.Type != typeAttachOK || numOf(env.Queued) != 2 {
		t.Fatalf("attach 回执不对: %+v", env)
	}
	arr := c.recv(t)
	if arr.Type != typeArrived || len(arr.Items) != 2 {
		t.Fatalf("attach 后应当收到两张图: %+v", arr)
	}
	for _, it := range arr.Items {
		info := mustStat(t, it.Path)
		if info.Size() != it.Bytes {
			t.Fatalf("%s 字节数对不上: %d vs %d", it.Path, info.Size(), it.Bytes)
		}
		if it.Mime != "image/jpeg" {
			t.Fatalf("mime 不对: %s", it.Mime)
		}
		if !strings.HasPrefix(filepath.Base(it.Path), it.ID) {
			t.Fatalf("文件名与 id 不一致: %s / %s", it.Path, it.ID)
		}
		if _, err := time.Parse(time.RFC3339, it.TS); err != nil {
			t.Fatalf("ts 不是 RFC3339: %q", it.TS)
		}
		if !filepath.IsAbs(it.Path) {
			t.Fatalf("path 应当是绝对路径: %s", it.Path)
		}
	}

	ids := []string{arr.Items[0].ID, arr.Items[1].ID}
	c.send(t, Envelope{Type: typeAck, IDs: ids})
	if ack := c.recv(t); ack.Type != typeAckOK || numOf(ack.Moved) != 2 {
		t.Fatalf("ack 回执不对: %+v", ack)
	}
	if ents, _ := os.ReadDir(r.st.queueDir()); len(ents) != 0 {
		t.Fatalf("ack 之后 queue 应当为空，实际 %d", len(ents))
	}
	arch := filepath.Join(r.st.Root(), "archive", time.Now().Format("20060102"))
	if ents, err := os.ReadDir(arch); err != nil || len(ents) != 2 {
		t.Fatalf("归档目录不对: %v %d", err, len(ents))
	}
	for _, it := range arr.Items {
		mustStat(t, filepath.Join(arch, filepath.Base(it.Path)))
	}

	listener, queued, delivered := r.status()
	if listener == nil || listener["sessionId"] != "s1" || listener["name"] != "pi-main" {
		t.Fatalf("status.listener 不对: %+v", listener)
	}
	if _, err := time.Parse(time.RFC3339, listener["since"].(string)); err != nil {
		t.Fatalf("since 不是 RFC3339: %v", listener["since"])
	}
	if queued != 0 || delivered != 2 {
		t.Fatalf("status 计数不对: queued=%d delivered=%d", queued, delivered)
	}

	// 重复 ack 不再搬动
	c.send(t, Envelope{Type: typeAck, IDs: ids})
	if ack := c.recv(t); numOf(ack.Moved) != 0 {
		t.Fatalf("重复 ack 应当 moved=0，实际 %+v", ack)
	}
}

// 有 holder 时上传直接推给 holder，不必等下一轮 flush。
func TestUploadDeliversToHolder(t *testing.T) {
	r := newRig(t)
	c, env := r.attach("s1", "甲", false)
	if env.Type != typeAttachOK || numOf(env.Queued) != 0 {
		t.Fatalf("attach 回执不对: %+v", env)
	}
	c.recvNone(t, 100*time.Millisecond)

	out := r.upload(jpegImage("x.jpg", 300))
	if out["accepted"] != float64(1) || out["delivered"] != float64(1) || out["queued"] != float64(1) {
		t.Fatalf("上传回执不对: %+v", out)
	}
	arr := c.recv(t)
	if arr.Type != typeArrived || len(arr.Items) != 1 {
		t.Fatalf("holder 应当立刻收到 arrived: %+v", arr)
	}
	if _, queued, delivered := r.status(); queued != 1 || delivered != 0 {
		t.Fatalf("ack 前 queued 应当是 1、delivered 应当是 0: %d %d", queued, delivered)
	}
}

func TestAttachBusyThenDetach(t *testing.T) {
	r := newRig(t)
	c1, env := r.attach("s1", "第一任", false)
	if env.Type != typeAttachOK {
		t.Fatalf("第一个 attach 应当拿到锁: %+v", env)
	}
	c2 := r.dial()
	env2 := r.attachOn(c2, "s2", "第二任", false)
	if env2.Type != typeBusy || env2.Holder == nil {
		t.Fatalf("第二个 attach 应当是 busy: %+v", env2)
	}
	if env2.Holder.SessionID != "s1" || env2.Holder.Name != "第一任" {
		t.Fatalf("busy 里的 holder 不对: %+v", env2.Holder)
	}
	if _, err := time.Parse(time.RFC3339, env2.Holder.Since); err != nil {
		t.Fatalf("holder.since 不是 RFC3339: %q", env2.Holder.Since)
	}
	// busy 不静默抢锁：老 holder 还活着，也没被关掉
	c1.send(t, Envelope{Type: typePing})
	if pong := c1.recv(t); pong.Type != typePong {
		t.Fatalf("ping 应当回 pong: %+v", pong)
	}

	c1.send(t, Envelope{Type: typeDetach})
	if env := c1.recv(t); env.Type != typeDetachOK {
		t.Fatalf("detach 回执不对: %+v", env)
	}
	if env := r.attachOn(c2, "s2", "第二任", false); env.Type != typeAttachOK {
		t.Fatalf("detach 之后应当能拿到锁: %+v", env)
	}
}

// 心跳超期判假死：旧连接收 preempted(stale) 并被关掉，锁给新来的。
func TestStalePreemptsHolder(t *testing.T) {
	r := newRig(t)
	c1, _ := r.attach("s1", "旧", false)

	r.srv.mu.Lock()
	r.srv.holder.lastSeen = time.Now().Add(-2 * r.srv.stale)
	r.srv.mu.Unlock()

	c2, env := r.attach("s2", "新", false)
	if env.Type != typeAttachOK {
		t.Fatalf("心跳超期时新来的该直接拿到锁: %+v", env)
	}
	if pre := c1.recv(t); pre.Type != typePreempted || pre.Reason != reasonStale {
		t.Fatalf("旧 holder 应当收到 preempted(stale): %+v", pre)
	}
	c1.recvNone(t, 200*time.Millisecond) // 连接已被守护关掉

	c2.send(t, Envelope{Type: typePing})
	if pong := c2.recv(t); pong.Type != typePong {
		t.Fatalf("新 holder ping 应当回 pong: %+v", pong)
	}
	if listener, _, _ := r.status(); listener == nil || listener["sessionId"] != "s2" {
		t.Fatalf("锁应当在新 holder 手上: %+v", listener)
	}
}

// force:true 不问心跳，直接抢。
func TestForcePreemptsFreshHolder(t *testing.T) {
	r := newRig(t)
	c1, _ := r.attach("s1", "旧", false)
	_, env := r.attach("s2", "新", true)
	if env.Type != typeAttachOK {
		t.Fatalf("force attach 应当拿到锁: %+v", env)
	}
	if pre := c1.recv(t); pre.Type != typePreempted || pre.Reason != reasonForced {
		t.Fatalf("旧 holder 应当收到 preempted(forced): %+v", pre)
	}
	if listener, _, _ := r.status(); listener == nil || listener["sessionId"] != "s2" {
		t.Fatalf("锁应当在新 holder 手上: %+v", listener)
	}
}

// holder 连接一断，锁当场释放；它收了没 ack 的图由下一任接手重推。
func TestHolderDisconnectReleasesLock(t *testing.T) {
	r := newRig(t)
	r.upload(jpegImage("a.jpg", 64))

	c1, _ := r.attach("s1", "甲", false)
	arr := c1.recv(t)
	if arr.Type != typeArrived || len(arr.Items) != 1 {
		t.Fatalf("第一任应当收到图: %+v", arr)
	}
	c1.close()

	waitFor(t, 2*time.Second, func() bool { return r.srv.listener() == nil }, "断连后锁应当释放")

	c2, env := r.attach("s2", "乙", false)
	if env.Type != typeAttachOK || numOf(env.Queued) != 1 {
		t.Fatalf("断连释锁后新 holder 该拿到锁和积压: %+v", env)
	}
	arr2 := c2.recv(t)
	if arr2.Type != typeArrived || len(arr2.Items) != 1 || arr2.Items[0].ID != arr.Items[0].ID {
		t.Fatalf("上一任没 ack 的图应当重推给新 holder: %+v", arr2)
	}
}

// 定时清理路径：没人来抢时也要把假死 holder 摘掉，否则页面一直显示有人在收。
func TestSweepStaleReleasesLock(t *testing.T) {
	r := newRig(t)
	c1, _ := r.attach("s1", "旧", false)
	r.srv.mu.Lock()
	r.srv.holder.lastSeen = time.Now().Add(-2 * r.srv.stale)
	r.srv.mu.Unlock()

	if !r.srv.sweepStale(time.Now()) {
		t.Fatal("sweepStale 应当判出假死")
	}
	if r.srv.listener() != nil {
		t.Fatal("扫过之后锁应当是空的")
	}
	if pre := c1.recv(t); pre.Type != typePreempted || pre.Reason != reasonStale {
		t.Fatalf("假死 holder 应当收到 preempted(stale): %+v", pre)
	}
}

func TestURLCarriesTokenAndLANAddr(t *testing.T) {
	r := newRig(t)
	c, _ := r.attach("s1", "甲", false)
	c.send(t, Envelope{Type: typeURL})
	env := c.recv(t)
	if env.Type != typeURLOK {
		t.Fatalf("url 回执不对: %+v", env)
	}
	want := "http://192.168.1.20:8787/?k=" + r.token()
	if env.URL != want {
		t.Fatalf("url 不对:\n got %s\nwant %s", env.URL, want)
	}
}

func TestFinishReleasesLock(t *testing.T) {
	r := newRig(t)
	c, _ := r.attach("s1", "甲", false)
	r.upload(jpegImage("a.jpg", 90))
	if arr := c.recv(t); arr.Type != typeArrived {
		t.Fatalf("应当先收到 arrived: %+v", arr)
	}
	if out := r.finish(); out["ok"] != true {
		t.Fatalf("finish 回执不对: %+v", out)
	}
	fin := c.recv(t)
	if fin.Type != typeFinish || fin.By != byWeb || numOf(fin.Count) != 1 {
		t.Fatalf("finish 事件不对: %+v", fin)
	}
	if r.srv.listener() != nil {
		t.Fatal("finish 之后锁应当释放")
	}
	if _, _, delivered := r.status(); delivered != 0 {
		t.Fatalf("finish 不归档，delivered 应当是 0，实际 %d", delivered)
	}
	c2, env := r.attach("s2", "乙", false)
	if env.Type != typeAttachOK {
		t.Fatalf("finish 之后新 holder 该直接拿到锁: %+v", env)
	}
	_ = c2
}

// 没锁的时候点「结束」也不该报错：用户要的是「这轮结束」这个结果。
func TestFinishWithoutHolder(t *testing.T) {
	r := newRig(t)
	if out := r.finish(); out["ok"] != true {
		t.Fatalf("无 holder 时 finish 也应当 ok: %+v", out)
	}
}

func TestHelloRequired(t *testing.T) {
	r := newRig(t)
	conn, err := dialRaw(r.srv.socketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.close()
	conn.send(t, Envelope{Type: typeHello, Role: "web"})
	env := conn.recv(t)
	if env.Type != typeError {
		t.Fatalf("非 pi 角色应当回 error: %+v", env)
	}
	if listener := r.srv.listener(); listener != nil {
		t.Fatalf("hello 没过不该拿到锁: %+v", listener)
	}
}

// pi 主动 detach 之后再断了，也不影响下一个人拿锁。
func TestDetachThenDisconnectNoop(t *testing.T) {
	r := newRig(t)
	c, _ := r.attach("s1", "甲", false)
	c.send(t, Envelope{Type: typeDetach})
	if env := c.recv(t); env.Type != typeDetachOK {
		t.Fatalf("detach 回执不对: %+v", env)
	}
	c.close()
	c2, env := r.attach("s2", "乙", false)
	if env.Type != typeAttachOK {
		t.Fatalf("应当能拿到锁: %+v", env)
	}
	_ = c2
}

func TestUnknownTypeAnswersError(t *testing.T) {
	r := newRig(t)
	c := r.dial()
	c.send(t, Envelope{Type: "nonsense", ID: "42"})
	env := c.recv(t)
	if env.Type != typeError || env.ID != "42" {
		t.Fatalf("未知消息应当回带 id 的 error: %+v", env)
	}
}
