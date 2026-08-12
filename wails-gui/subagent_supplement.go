package main

// subagent_supplement.go — Task 4: Wails 补充指令队列存储（Go 侧）
//
// 与 Node lib/subagent-supplement.ts 直接互操作，绝不 spawn Node：
//   - 读同一 JSON schema（inboxId / createdAt / updatedAt / entries，
//     entry 为 {id, text, state, createdAt, handedOffAt?}，camelCase，handedOffAt 缺失时省略）；
//   - <file>.lock 目录互斥（5s 超时 / 10s stale mtime 回收）；
//   - 同目录临时文件 + fsync + rename 原子落盘；root 0700、队列文件 0600；
//   - 仅支持 read/enqueue/withdraw/merge（claim/release 仍是 Node worker 的职责）；
//   - Go 生成的 entry id 为 crypto/rand 的 ASCII 安全十六进制串。
//
// 安全约束：本文件所有错误信息绝不包含文件路径/根目录（GUI 直接展示错误文本）。

import (
	cryptorand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"time"
)

// ── 协议常量（与 Node 常量保持一致） ──

const (
	// supplementMaxText 单条补充正文上限（字符）。
	supplementMaxText = 4000
	// supplementMaxEntries 单 inbox 容量上限（pending + handoff 合计）。
	supplementMaxEntries = 30
)

// 锁等待超时与 stale 阈值（测试可临时改写以加速锁用例）。
var (
	supplementLockTimeout = 5 * time.Second
	supplementLockStale   = 10 * time.Second
)

// ── Wire 类型（对齐 Node SupplementInbox / SupplementEntry，JSON 字段名 camelCase） ──

// SupplementEntry 单条补充指令；state 为 "pending" | "handoff"。
// handedOffAt 缺失（pending / 未被 claim 过）时以 omitempty 省略，与 Node 一致。
type SupplementEntry struct {
	ID          string `json:"id"`
	Text        string `json:"text"`
	State       string `json:"state"`
	CreatedAt   string `json:"createdAt"`
	HandedOffAt string `json:"handedOffAt,omitempty"`
}

// SubagentSupplementInbox 一条 FIFO 补充队列快照。
type SubagentSupplementInbox struct {
	InboxID   string            `json:"inboxId"`
	CreatedAt string            `json:"createdAt"`
	UpdatedAt string            `json:"updatedAt"`
	Entries   []SupplementEntry `json:"entries"`
}

// SubagentSupplementMutation withdraw/merge 的返回载荷：新快照 + 本次是否生效。
type SubagentSupplementMutation struct {
	Inbox     SubagentSupplementInbox `json:"inbox"`
	Withdrawn bool                    `json:"withdrawn"`
	Merged    bool                    `json:"merged"`
}

// ── inboxId 校验（与 Node isValidInboxId 同规则） ──

var supplementInboxIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

func isValidInboxID(inboxID string) bool {
	return supplementInboxIDRe.MatchString(inboxID)
}

// ── 时钟与 ID ──

// supplementNow 生成 Node toISOString 同形的时间戳（UTC，毫秒精度，Z 后缀）。
func supplementNow() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

// supplementNewID 生成 crypto/rand 的 ASCII 安全 id（16 字节十六进制，32 字符）。
func supplementNewID() string {
	var b [16]byte
	if _, err := cryptorand.Read(b[:]); err != nil {
		return fmt.Sprintf("s%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b[:])
}

// ── 路径与权限 ──

func supplementQueueFile(root, inboxID string) string {
	return filepath.Join(root, inboxID+".json")
}

// supplementEnsureRoot 确保根目录存在且 owner 权限不宽于 0o700：
// 自建后收紧到 0o700；已存在时仅清除 0o700 之外的多余位，绝不放宽。
func supplementEnsureRoot(root string) error {
	st, err := os.Stat(root)
	if err == nil {
		perm := st.Mode().Perm()
		tightened := perm & 0o700
		if tightened != perm {
			_ = os.Chmod(root, tightened)
		}
		return nil
	}
	if !os.IsNotExist(err) {
		return err
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return err
	}
	_ = os.Chmod(root, 0o700)
	return nil
}

var supplementTmpSeq atomic.Uint64

// supplementAtomicWrite 同目录临时文件 + fsync + rename 原子落盘，文件 owner-only。
func supplementAtomicWrite(file string, data []byte) error {
	tmp := fmt.Sprintf("%s.tmp-%d-%d", file, os.Getpid(), supplementTmpSeq.Add(1))
	fd, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := fd.Write(data); err != nil {
		fd.Close()
		os.Remove(tmp)
		return err
	}
	if err := fd.Sync(); err != nil {
		fd.Close()
		os.Remove(tmp)
		return err
	}
	if err := fd.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, file); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// ── 锁（与 Node withLock 语义一致） ──

// supplementLockIsStale 锁目录 mtime 过旧即视为 stale（写者已崩溃），可回收。
func supplementLockIsStale(lockDir string, stale time.Duration) bool {
	st, err := os.Stat(lockDir)
	if err != nil {
		return false
	}
	return time.Since(st.ModTime()) > stale
}

// withSupplementLock 以锁目录互斥执行 fn：mkdir 成功即持锁，finally 必释放。
// 锁被占时轮询等待至超时；仅当锁 stale 时才强制回收。错误不含路径。
func withSupplementLock(root, inboxID string, fn func() error) error {
	lockDir := supplementQueueFile(root, inboxID) + ".lock"
	deadline := time.Now().Add(supplementLockTimeout)
	for {
		err := os.Mkdir(lockDir, 0o700)
		if err == nil {
			break
		}
		if !os.IsExist(err) {
			return err
		}
		if supplementLockIsStale(lockDir, supplementLockStale) {
			_ = os.RemoveAll(lockDir)
			continue
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("timed out after %s waiting for queue lock", supplementLockTimeout)
		}
		time.Sleep(time.Duration(10+rand.IntN(20)) * time.Millisecond)
	}
	defer os.RemoveAll(lockDir)
	return fn()
}

// ── 读取与校验（与 Node readQueueFile 容错语义对齐） ──

// supplementReadInbox 读取并校验队列文件；缺失或损坏抛错（错误不含路径）。
func supplementReadInbox(root, inboxID string) (SubagentSupplementInbox, error) {
	data, err := os.ReadFile(supplementQueueFile(root, inboxID))
	if err != nil {
		if os.IsNotExist(err) {
			return SubagentSupplementInbox{}, fmt.Errorf("inbox file not found")
		}
		return SubagentSupplementInbox{}, err
	}
	return supplementParseInbox(data)
}

func supplementParseInbox(data []byte) (SubagentSupplementInbox, error) {
	var inbox SubagentSupplementInbox
	if err := json.Unmarshal(data, &inbox); err != nil {
		return SubagentSupplementInbox{}, fmt.Errorf("corrupt inbox file (invalid JSON)")
	}
	if !isValidInboxID(inbox.InboxID) || inbox.CreatedAt == "" || inbox.UpdatedAt == "" || inbox.Entries == nil {
		return SubagentSupplementInbox{}, fmt.Errorf("corrupt inbox file (bad shape)")
	}
	for _, e := range inbox.Entries {
		if !isValidInboxID(e.ID) || (e.State != "pending" && e.State != "handoff") {
			return SubagentSupplementInbox{}, fmt.Errorf("corrupt inbox file (bad entry)")
		}
	}
	return inbox, nil
}

func supplementWriteInbox(root, inboxID string, inbox *SubagentSupplementInbox) error {
	data, err := json.MarshalIndent(inbox, "", "  ")
	if err != nil {
		return err
	}
	return supplementAtomicWrite(supplementQueueFile(root, inboxID), append(data, '\n'))
}

// ── 队列操作（纯存储层：不做 worker 生命周期判断，那是 App 层的职责） ──

// supplementEnqueue 队尾追加一条 pending（FIFO）。空白/超长/容量满拒绝。
func supplementEnqueue(root, inboxID, text string, now func() string, id func() string) (SubagentSupplementInbox, error) {
	if !isValidInboxID(inboxID) {
		return SubagentSupplementInbox{}, fmt.Errorf("invalid inboxId %q: must be 1-128 chars of [A-Za-z0-9_-]", inboxID)
	}
	if strings.TrimSpace(text) == "" {
		return SubagentSupplementInbox{}, fmt.Errorf("supplement text must not be blank")
	}
	if len([]rune(text)) > supplementMaxText {
		return SubagentSupplementInbox{}, fmt.Errorf("supplement text too long: %d chars (max %d)", len([]rune(text)), supplementMaxText)
	}
	if err := supplementEnsureRoot(root); err != nil {
		return SubagentSupplementInbox{}, err
	}
	var out SubagentSupplementInbox
	err := withSupplementLock(root, inboxID, func() error {
		inbox, err := supplementReadInbox(root, inboxID)
		if err != nil {
			return err
		}
		if len(inbox.Entries) >= supplementMaxEntries {
			return fmt.Errorf("inbox %s is full: %d entries", inboxID, supplementMaxEntries)
		}
		nowStr := now()
		inbox.Entries = append(inbox.Entries, SupplementEntry{
			ID: id(), Text: text, State: "pending", CreatedAt: nowStr,
		})
		inbox.UpdatedAt = nowStr
		if err := supplementWriteInbox(root, inboxID, &inbox); err != nil {
			return err
		}
		out = inbox
		return nil
	})
	return out, err
}

// supplementWithdraw 撤回一条 pending；handoff 不可撤回、未知 id 返回 withdrawn false 且不写盘。
func supplementWithdraw(root, inboxID, entryID string, now func() string) (SubagentSupplementInbox, bool, error) {
	var out SubagentSupplementInbox
	withdrawn := false
	err := withSupplementLock(root, inboxID, func() error {
		inbox, err := supplementReadInbox(root, inboxID)
		if err != nil {
			return err
		}
		idx := -1
		for i, e := range inbox.Entries {
			if e.ID == entryID && e.State == "pending" {
				idx = i
				break
			}
		}
		if idx == -1 {
			out = inbox
			return nil
		}
		inbox.Entries = append(inbox.Entries[:idx], inbox.Entries[idx+1:]...)
		inbox.UpdatedAt = now()
		if err := supplementWriteInbox(root, inboxID, &inbox); err != nil {
			return err
		}
		out = inbox
		withdrawn = true
		return nil
	})
	return out, withdrawn, err
}

// supplementMerge 把所有 pending 按原顺序合并为一条（位于最早 pending 的原位置），
// handoff 原样保留相对顺序；少于 2 条 pending 返回 merged false 且不写盘。
// 正文按 Node 同款 `--- Supplement N ---`（N 从 2 起，空行分隔）连接。
func supplementMerge(root, inboxID string, now func() string, id func() string) (SubagentSupplementInbox, bool, error) {
	var out SubagentSupplementInbox
	merged := false
	err := withSupplementLock(root, inboxID, func() error {
		inbox, err := supplementReadInbox(root, inboxID)
		if err != nil {
			return err
		}
		var pending []SupplementEntry
		firstPendingIdx := -1
		for i, e := range inbox.Entries {
			if e.State == "pending" {
				if firstPendingIdx == -1 {
					firstPendingIdx = i
				}
				pending = append(pending, e)
			}
		}
		if len(pending) < 2 {
			out = inbox
			return nil
		}
		var parts []string
		for i, e := range pending {
			if i > 0 {
				parts = append(parts, fmt.Sprintf("--- Supplement %d ---", i+1))
			}
			parts = append(parts, e.Text)
		}
		mergedEntry := SupplementEntry{
			ID: id(), Text: strings.Join(parts, "\n\n"), State: "pending", CreatedAt: now(),
		}
		next := make([]SupplementEntry, 0, len(inbox.Entries))
		for i, e := range inbox.Entries {
			if i == firstPendingIdx {
				next = append(next, mergedEntry)
			} else if e.State == "handoff" {
				next = append(next, e)
			}
		}
		inbox.Entries = next
		inbox.UpdatedAt = now()
		if err := supplementWriteInbox(root, inboxID, &inbox); err != nil {
			return err
		}
		out = inbox
		merged = true
		return nil
	})
	return out, merged, err
}

// ── App 侧：路径解析与 status 校验 ──

// supplementRootDir 返回配置的队列根目录；空 -> ~/.pi/subagent-supplements。
func (a *App) supplementRootDir() string {
	if a.supplementRoot != "" {
		return a.supplementRoot
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".pi", "subagent-supplements")
}

// statusSnapshotPath 返回配置的 status 快照路径；空 -> ~/.pi/subagent-status.json。
func (a *App) statusSnapshotPath() string {
	if a.statusPath != "" {
		return a.statusPath
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".pi", "subagent-status.json")
}

// supplementWorkerStatus 在当前 status 快照中查找 inboxId 对应的 worker 状态。
// 快照缺失/损坏/未找到一律返回 found=false。
func (a *App) supplementWorkerStatus(inboxID string) (status string, found bool) {
	data, err := os.ReadFile(a.statusSnapshotPath())
	if err != nil {
		return "", false
	}
	var doc struct {
		Workers []struct {
			InboxID string `json:"inboxId"`
			Status  string `json:"status"`
		} `json:"workers"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return "", false
	}
	for _, w := range doc.Workers {
		if w.InboxID == inboxID {
			return w.Status, true
		}
	}
	return "", false
}

// sanitizeErr 抹掉队列根/status 路径，杜绝 GUI 错误文本泄露本机路径。
func (a *App) sanitizeErr(err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	msg = strings.ReplaceAll(msg, a.supplementRootDir(), "<queue-root>")
	msg = strings.ReplaceAll(msg, a.statusSnapshotPath(), "<status>")
	return errors.New(msg)
}

// ── Wails 绑定方法（简单签名，返回类型 JSON 绑定稳定） ──

// QueueSubagentSupplement 仅对当前 status 中 starting/running 的 worker 入队；
// 未知 inbox / terminal 生命周期一律拒绝且不写盘。错误为可直接展示的英文。
func (a *App) QueueSubagentSupplement(inboxID, text string) (SubagentSupplementInbox, error) {
	if !isValidInboxID(inboxID) {
		return SubagentSupplementInbox{}, fmt.Errorf("invalid inboxId %q: must be 1-128 chars of [A-Za-z0-9_-]", inboxID)
	}
	status, found := a.supplementWorkerStatus(inboxID)
	if !found {
		return SubagentSupplementInbox{}, fmt.Errorf("unknown inboxId %q: no worker with that inbox in the current subagent status", inboxID)
	}
	if status != "starting" && status != "running" {
		return SubagentSupplementInbox{}, fmt.Errorf("worker lifecycle has ended (status: %s); it cannot receive further supplements", status)
	}
	inbox, err := supplementEnqueue(a.supplementRootDir(), inboxID, text, supplementNow, supplementNewID)
	return inbox, a.sanitizeErr(err)
}

// WithdrawSubagentSupplement 撤回一条 pending；terminal 生命周期也允许（只编辑本地草稿队列），
// 但要求 inbox 在当前 status 中已知。
func (a *App) WithdrawSubagentSupplement(inboxID, entryID string) (SubagentSupplementMutation, error) {
	if !isValidInboxID(inboxID) {
		return SubagentSupplementMutation{}, fmt.Errorf("invalid inboxId %q: must be 1-128 chars of [A-Za-z0-9_-]", inboxID)
	}
	if _, found := a.supplementWorkerStatus(inboxID); !found {
		return SubagentSupplementMutation{}, fmt.Errorf("unknown inboxId %q: no worker with that inbox in the current subagent status", inboxID)
	}
	inbox, withdrawn, err := supplementWithdraw(a.supplementRootDir(), inboxID, entryID, supplementNow)
	if err != nil {
		return SubagentSupplementMutation{}, a.sanitizeErr(err)
	}
	return SubagentSupplementMutation{Inbox: inbox, Withdrawn: withdrawn}, nil
}

// MergeSubagentSupplements 合并全部 pending；terminal 生命周期也允许（只编辑本地草稿队列），
// 但要求 inbox 在当前 status 中已知。
func (a *App) MergeSubagentSupplements(inboxID string) (SubagentSupplementMutation, error) {
	if !isValidInboxID(inboxID) {
		return SubagentSupplementMutation{}, fmt.Errorf("invalid inboxId %q: must be 1-128 chars of [A-Za-z0-9_-]", inboxID)
	}
	if _, found := a.supplementWorkerStatus(inboxID); !found {
		return SubagentSupplementMutation{}, fmt.Errorf("unknown inboxId %q: no worker with that inbox in the current subagent status", inboxID)
	}
	inbox, merged, err := supplementMerge(a.supplementRootDir(), inboxID, supplementNow, supplementNewID)
	if err != nil {
		return SubagentSupplementMutation{}, a.sanitizeErr(err)
	}
	return SubagentSupplementMutation{Inbox: inbox, Merged: merged}, nil
}
