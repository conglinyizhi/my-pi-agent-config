package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// itemSeq 给同一毫秒内的多张图排序用，见 newItemID。
var itemSeq atomic.Uint64

var (
	errUnknownMime = errors.New("不支持的图片类型")
	errBadDataURL  = errors.New("dataUrl 格式不对")
	errEmptyImage  = errors.New("图片内容为空")
)

// 落盘布局（-state，默认 ~/.pi/agent/photo-state）：
//
//	queue/<id>.<ext>             待投递
//	archive/YYYYMMDD/<id>.<ext>  已被 pi ack
//	token                        HTTP 口令，0600
//
// 文件就是队列的唯一事实来源：重启后扫一遍 queue/ 就恢复了，
// 不再另写一份索引文件——索引一旦和文件不同步，就得临时决定信谁，
// 那是白白多出来的一种失败模式。
type Store struct {
	root  string
	token string

	mu    sync.Mutex
	items []*queueItem
	// delivered 是已归档张数。启动时扫一次 archive/，之后按 ack 递增：
	// 宁可启动时慢一点，也不想为了一个计数再落一份状态。
	delivered int
}

// queueItem 是队列里的一项。落盘信息全在文件名与文件本身，进程内的只有 pushed。
type queueItem struct {
	ID    string
	Path  string
	Mime  string
	Bytes int64
	TS    time.Time
	// pushed 表示已经推给过当前 holder。新的 holder 接手时全部按未推算：
	// 上一任收了没 ack 就断了，那些图还在 queue 里，该由下一任拿走。
	pushed bool
}

func (q *queueItem) item() Item {
	return Item{ID: q.ID, Path: q.Path, Mime: q.Mime, Bytes: q.Bytes, TS: rfc3339(q.TS)}
}

// mimeExt 是允许落盘的类型。页面永远发 JPEG（canvas 压完就是 JPEG），
// 这里留 png/webp 是为了别人手搓请求时不至于默默丢图；表外的类型直接拒，
// 不猜扩展名——按内容猜错扩展名，比拒绝更难查。
var mimeExt = map[string]string{
	"image/jpeg": ".jpg",
	"image/png":  ".png",
	"image/webp": ".webp",
}

func extMime(ext string) (string, bool) {
	switch ext {
	case ".jpg", ".jpeg":
		return "image/jpeg", true
	case ".png":
		return "image/png", true
	case ".webp":
		return "image/webp", true
	}
	return "", false
}

func newStore(root string) (*Store, error) {
	if root == "" {
		return nil, errors.New("state 目录为空")
	}
	s := &Store{root: root}
	if err := os.MkdirAll(s.queueDir(), 0o700); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Join(root, "archive"), 0o700); err != nil {
		return nil, err
	}
	token, err := loadToken(filepath.Join(root, "token"))
	if err != nil {
		return nil, err
	}
	s.token = token
	s.loadQueue()
	s.delivered = countArchived(filepath.Join(root, "archive"))
	return s, nil
}

func (s *Store) queueDir() string { return filepath.Join(s.root, "queue") }
func (s *Store) Token() string    { return s.token }
func (s *Store) Root() string     { return s.root }
func (s *Store) Delivered() int   { s.mu.Lock(); defer s.mu.Unlock(); return s.delivered }

// Queued 是 queue/ 里还没被 ack 的张数。已推未 ack 的也算在内：
// 图在被 ack 之前一直躺在 queue 里，口径跟着磁盘走才不会有两种「剩余」。
func (s *Store) Queued() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.items)
}

// loadToken 读不到就生成，读到坏的重建。token 是给人扫码用的便利口令，
// 不是安全边界（同一个 wifi 里本来就不设防），所以坏文件不必让守护起不来。
func loadToken(path string) (string, error) {
	if b, err := os.ReadFile(path); err == nil {
		if t := strings.TrimSpace(string(b)); validToken(t) {
			return t, nil
		}
		log.Printf("token 文件内容不是 32 位 hex，已重建: %s", path)
	} else if !os.IsNotExist(err) {
		return "", err
	}
	t, err := newToken()
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(path, []byte(t+"\n"), 0o600); err != nil {
		return "", err
	}
	return t, nil
}

func newToken() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

func validToken(t string) bool {
	if len(t) != 32 {
		return false
	}
	for _, c := range t {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// loadQueue 重建内存队列。排序按 id 再按文件名：id 前缀是毫秒时间戳，
// 字符串序就是时间序，重启后投递顺序和拍的时候一致。
func (s *Store) loadQueue() {
	ents, err := os.ReadDir(s.queueDir())
	if err != nil {
		log.Printf("读 queue 目录失败: %v", err)
		return
	}
	var items []*queueItem
	for _, e := range ents {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		ext := filepath.Ext(name)
		mime, ok := extMime(ext)
		if !ok {
			continue
		}
		id := strings.TrimSuffix(name, ext)
		info, err := e.Info()
		if err != nil {
			continue
		}
		items = append(items, &queueItem{
			ID:    id,
			Path:  filepath.Join(s.queueDir(), name),
			Mime:  mime,
			Bytes: info.Size(),
			TS:    info.ModTime(),
		})
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].ID != items[j].ID {
			return items[i].ID < items[j].ID
		}
		return items[i].Path < items[j].Path
	})
	s.mu.Lock()
	s.items = items
	s.mu.Unlock()
}

// Enqueue 把一张图落到 queue/。mime 不在表里就拒收，不落盘：
// 落一张扩展名和内容对不上的文件，后面每个读它的人都要多判一次。
func (s *Store) Enqueue(mime string, data []byte) (*queueItem, error) {
	ext, ok := mimeExt[mime]
	if !ok {
		return nil, errUnknownMime
	}
	if len(data) == 0 {
		return nil, errEmptyImage
	}
	now := time.Now()
	id := newItemID(now)
	path := filepath.Join(s.queueDir(), id+ext)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return nil, err
	}
	it := &queueItem{ID: id, Path: path, Mime: mime, Bytes: int64(len(data)), TS: now}
	s.mu.Lock()
	s.items = append(s.items, it)
	s.mu.Unlock()
	return it, nil
}

// newItemID 形如 1758859200123-0007-a1b2c3d4：毫秒时间戳在前，id 的字符串序就是
// 投递顺序；同毫秒内再垫一个自增序号，否则同一批上传的几张图在重启后会按随机后缀
// 重排。id 一旦发出就不再变，pi 侧可以拿它去重。
func newItemID(t time.Time) string {
	var b [4]byte
	_, _ = rand.Read(b[:])
	return fmt.Sprintf("%013d-%04d-%s", t.UnixMilli(), itemSeq.Add(1)%10000, hex.EncodeToString(b[:]))
}

// Unpushed 返回还没推给当前 holder 的项。返回的是副本指针，
// 调用方只读，改动一律走 MarkPushed，免得两处各记一份状态。
func (s *Store) Unpushed() []*queueItem {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*queueItem, 0, len(s.items))
	for _, it := range s.items {
		if !it.pushed {
			out = append(out, it)
		}
	}
	return out
}

func (s *Store) MarkPushed(ids []string) {
	if len(ids) == 0 {
		return
	}
	set := map[string]bool{}
	for _, id := range ids {
		set[id] = true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, it := range s.items {
		if set[it.ID] {
			it.pushed = true
		}
	}
}

// ResetPushed：新的 holder 接手，队列里所有未 ack 的都算没推过。上一任断线前
// 收到但没 ack 的图，只有靠这一下才能回到下一任手上；重复投递由 pi 按 id 去重。
func (s *Store) ResetPushed() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, it := range s.items {
		it.pushed = false
	}
}

// PushedCount 数这批 id 里有多少已经在当前 holder 手上，用于 upload 回执。
func (s *Store) PushedCount(ids []string) int {
	if len(ids) == 0 {
		return 0
	}
	set := map[string]bool{}
	for _, id := range ids {
		set[id] = true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, it := range s.items {
		if set[it.ID] && it.pushed {
			n++
		}
	}
	return n
}

// Ack 把指定 id 从 queue 移到 archive/YYYYMMDD/。归档日期取 ack 当天，
// 不取拍摄时间：这份目录是「哪天的投递被消费了」的日志，不是相册。
func (s *Store) Ack(ids []string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	dir := filepath.Join(s.root, "archive", time.Now().Format("20060102"))
	moved := 0
	for _, id := range ids {
		idx := -1
		for i, it := range s.items {
			if it.ID == id {
				idx = i
				break
			}
		}
		if idx < 0 {
			continue // 不在队列里：重复 ack，或已被抢占后的重推前就被移走
		}
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return moved, err
		}
		src := s.items[idx].Path
		dst := filepath.Join(dir, filepath.Base(src))
		if _, err := os.Stat(dst); err == nil {
			// id 唯一，撞名只可能是人为搬回来的。换个后缀两份都留着，
			// 归档目录里覆盖或删除都不可逆，不值得为这点整洁冒风险
			dst = dupName(dir, filepath.Base(src))
		}
		if err := os.Rename(src, dst); err != nil {
			log.Printf("归档 %s 失败: %v", id, err)
			continue
		}
		s.items = append(s.items[:idx], s.items[idx+1:]...)
		moved++
	}
	s.delivered += moved
	return moved, nil
}

func dupName(dir, base string) string {
	ext := filepath.Ext(base)
	stem := strings.TrimSuffix(base, ext)
	for i := 1; i < 100; i++ {
		path := filepath.Join(dir, fmt.Sprintf("%s-dup%d%s", stem, i, ext))
		if _, err := os.Stat(path); os.IsNotExist(err) {
			return path
		}
	}
	return filepath.Join(dir, fmt.Sprintf("%s-dup%s", stem, ext))
}

// countArchived 数归档总张数。只在启动时跑一次，之后维护计数，
// 免得页面每几秒轮询一次 status 就去遍历一遍 archive。
func countArchived(dir string) int {
	days, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	n := 0
	for _, d := range days {
		if !d.IsDir() {
			continue
		}
		files, err := os.ReadDir(filepath.Join(dir, d.Name()))
		if err != nil {
			continue
		}
		n += len(files)
	}
	return n
}
