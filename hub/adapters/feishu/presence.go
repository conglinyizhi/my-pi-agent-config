package main

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"time"
)

// presenceTimeout 是 presence 查询这一整趟的时限（连上 + hello + 询问）。
// 就是本机的一条 Unix socket，超过这个数说明 hub 根本没在处理这类消息，再等也等不到；
// 按「查不到」收手，照常推卡，比把卡压在这里强。
const presenceTimeout = 2 * time.Second

// presenceMsg 是 presence 这条短连接上的消息，只列用得到的字段。
// 不跟 hubClient 的 envelope 复用：那条主连接上的请求 / 响应字段多得多，
// 混用会让人以为改这里的字段那边也跟着动。
type presenceMsg struct {
	V        int    `json:"v"`
	Type     string `json:"type"`
	ID       string `json:"id,omitempty"`
	Role     string `json:"role,omitempty"`
	IdleMs   int64  `json:"idleMs,omitempty"`
	HasInput bool   `json:"hasInput,omitempty"`
	Message  string `json:"message,omitempty"`
}

// probePresence 问 hub 一句「本机最近还有键鼠活动吗」。
//
// 每次新开一条短连接，问完就关，绝不复用 hubClient 那条主连接：它的 rpc 从 pending
// channel 里按先来后到取响应，不按 id 匹配；推卡前的这次询问会和用户点按钮触发的
// decide 并发，共用一条连接两条响应就串了（现在 pair / list / decide 都是串行用的，
// 所以那边没事）。
//
// 返回 idle（距最后一次键鼠按下的时长）和 hasInput（hub 能不能读到输入设备）。
// err 非 nil 时调用方照常推卡：查不到在场状态，不等于用户不在。
func probePresence(socketPath string, timeout time.Duration) (time.Duration, bool, error) {
	conn, err := net.DialTimeout("unix", socketPath, timeout)
	if err != nil {
		return 0, false, fmt.Errorf("连不上 hub：%w", err)
	}
	defer conn.Close()
	// 整个往返都封在 deadline 里：问一句卡住也得有个头
	_ = conn.SetDeadline(time.Now().Add(timeout))

	enc := json.NewEncoder(conn)
	dec := json.NewDecoder(conn)

	if err := enc.Encode(presenceMsg{V: 1, Type: "hello", Role: "adapter"}); err != nil {
		return 0, false, fmt.Errorf("发 hello：%w", err)
	}
	var hello presenceMsg
	if err := dec.Decode(&hello); err != nil {
		return 0, false, fmt.Errorf("读 hello-ok：%w", err)
	}
	if hello.Type != "hello-ok" {
		return 0, false, fmt.Errorf("hub hello 失败：%s", hello.Type)
	}

	id, err := newPresenceID()
	if err != nil {
		return 0, false, fmt.Errorf("生成查询 id：%w", err)
	}
	if err := enc.Encode(presenceMsg{V: 1, Type: "presence", ID: id}); err != nil {
		return 0, false, fmt.Errorf("发 presence：%w", err)
	}
	// 等自己那条回执。这条短连接活着的那几毫秒里，hub 的 ask / settled 广播也可能
	// 发到这里（它按角色扇出，不看是不是主连接）：那些不是答案，跳过就行，
	// 反正主连接也会收到同一份。deadline 兜着底，不会在这儿空转
	for {
		var out presenceMsg
		if err := dec.Decode(&out); err != nil {
			return 0, false, fmt.Errorf("读 presence-ok：%w", err)
		}
		switch out.Type {
		case "presence-ok":
			// 契约要求回执带上原 id。对不上号说明这条连接上的消息不是答我们那句，
			// 那种数就不能拿来做「人在不在」的判断
			if out.ID != id {
				return 0, false, fmt.Errorf("presence 回执 id 不匹配：%s", out.ID)
			}
			if out.IdleMs < 0 {
				return 0, false, fmt.Errorf("presence 回执 idleMs 为负：%d", out.IdleMs)
			}
			return time.Duration(out.IdleMs) * time.Millisecond, out.HasInput, nil
		case "error":
			// 旧版 hub 不认这个类型，再等也不会有答案
			return 0, false, fmt.Errorf("hub 不接受 presence：%s", out.Message)
		}
	}
}

// newPresenceID 生成这次查询的 id（UUID v4 形状）。
// 用 UUID 而不是自增计数：这些短连接互不知情，计数没法保证不撞。
func newPresenceID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40 // 版本 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10xx
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

// holdWhilePresent 是推卡前的在场闸门，交给 cardQueue 当 hold 用：
// 本机最近 presence-window 内还有键鼠按动就返回 true（先别推卡），让队列等
// presence-retry 再问一次。
//
// 判不出来的一律当「不在」，照常推卡：这张卡只是可能多余，而压着不发会让一条
// 审批静默地烂在队列里。真在电脑前的人会从本机窗或本地 TUI 把决策拿走。
func (a *adapter) holdWhilePresent(requestID string) func() bool {
	return func() bool {
		if a.presenceWindow <= 0 {
			return false // 窗口关掉了：不做这次询问，按原样推
		}
		idle, hasInput, err := probePresence(a.socketPath, presenceTimeout)
		if err != nil {
			log.Printf("ask %s：presence 查询失败（%v），照常推卡", requestID, err)
			return false
		}
		// hub 读不到输入设备（无 X / Wayland 会话、权限不够）：它答不了这个问题，
		// 不接受一个「0 毫秒前刚动过」的默认值
		if !hasInput {
			log.Printf("ask %s：hub 读不到输入设备，在场状态未知，照常推卡", requestID)
			return false
		}
		if idle < a.presenceWindow {
			log.Printf("ask %s：本机 %s 内有键鼠活动（idle %s），先不推卡", requestID, a.presenceWindow, idle.Round(time.Second))
			return true
		}
		return false
	}
}
