package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
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
	errNoRef       = errors.New("编号不存在")
	errBadPool     = errors.New("编号池大小必须 ≥ 1")
	errNoFreeRef   = errors.New("编号池分配不出编号")
	// errNoFile：表里那条记录的图片文件已经不在磁盘上。删除时它和 errNoRef 一样
	// 回 404——「这个号现在没图」对用户是同一件事，不报 500。
	errNoFile = errors.New("图片文件已不在")
	// errOutside：表里的路径不落在归档目录内。表是磁盘上的文件，可能被手改过，
	// 删除不可逆，按可疑记录去删比拒绝更糟。
	errOutside = errors.New("编号表里的路径不在归档目录内")
)

// 落盘布局（-state，默认 ~/.pi/agent/photo-state）：
//
//	archive/YYYYMMDD/<id>.<ext>  图片本体，落了就不删
//	refs/index.json              短编号表
//	token                        HTTP 口令，0600
//
// 编号表要单独落一份索引，因为「文件叫什么」和「用户引用几号」是两层语义：
// 图片按时间戳命名，短编号推不回来（回收之后更推不回来）。
// 索引和 archive 不同步时以索引为准：多出来的文件最多是孤儿，编号错了才是错。
type Store struct {
	root  string
	pool  int
	token string

	mu    sync.Mutex
	items map[int]*RefItem
}

// RefItem 是编号池里的一条。时间字段用 RFC3339(UTC) 字符串而不是 time.Time：
// 落盘格式、HTTP 回应、内存里存的是同一份东西，不必再为「内存里怎么放」定一套转换。
// 小数秒是必要的——同一秒里连传几张图时，回收顺序要靠它排出来。
type RefItem struct {
	Ref      int    `json:"ref"`
	Path     string `json:"path"`
	Bytes    int64  `json:"bytes"`
	TS       string `json:"ts"`
	LastUsed string `json:"lastUsed,omitempty"`
}

func (it *RefItem) clone() *RefItem {
	c := *it
	return &c
}

// evictKey 是回收排序用的时间：用过就以最后一次使用为准，没用过按入库时间。
// 两个都解析不出来时归零值；零值最早，也就是最先被回收。
func (it *RefItem) evictKey() time.Time {
	for _, s := range []string{it.LastUsed, it.TS} {
		if s == "" {
			continue
		}
		if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
			return t
		}
	}
	return time.Time{}
}

func rfc3339(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

// indexFile 是 refs/index.json 的结构。外面套一层 items 是为了以后还能加字段
// （比如记下当时的 pool 大小）而不破坏老读法。
type indexFile struct {
	Items []*RefItem `json:"items"`
}

// mimeExt 是允许落盘的类型。页面永远发 JPEG（canvas 压完就是 JPEG），
// 这里留 png/webp 是为了别人手搓请求时不至于默默丢图；表外的类型直接拒，
// 不猜扩展名——按内容猜错扩展名，比拒绝更难查。
var mimeExt = map[string]string{
	"image/jpeg": ".jpg",
	"image/png":  ".png",
	"image/webp": ".webp",
}

func newStore(root string, pool int) (*Store, error) {
	if root == "" {
		return nil, errors.New("state 目录为空")
	}
	if pool < 1 {
		return nil, errBadPool
	}
	s := &Store{root: root, pool: pool, items: map[int]*RefItem{}}
	if err := os.MkdirAll(filepath.Join(root, "archive"), 0o700); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(s.refsDir(), 0o700); err != nil {
		return nil, err
	}
	token, err := loadToken(filepath.Join(root, "token"))
	if err != nil {
		return nil, err
	}
	s.token = token
	if err := s.loadIndex(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) refsDir() string   { return filepath.Join(s.root, "refs") }
func (s *Store) indexPath() string { return filepath.Join(s.refsDir(), "index.json") }
func (s *Store) Token() string     { return s.token }
func (s *Store) Root() string      { return s.root }
func (s *Store) Pool() int         { return s.pool }

// Used 是编号表里当前的条数（≤ pool，池调小之后可能暂时超出）。
func (s *Store) Used() int {
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

// loadIndex 从磁盘恢复编号表。文件坏了不当场挂掉：图片都还在 archive，
// 编号表本来就能靠重新上传或直接用路径重建，起不来才是真的没法用。
// 坏文件改名留档，好让「编号怎么全变了」这件事有据可查。
func (s *Store) loadIndex() error {
	buf, err := os.ReadFile(s.indexPath())
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var idx indexFile
	if err := json.Unmarshal(buf, &idx); err != nil {
		bad := s.indexPath() + ".bad-" + time.Now().Format("20060102T150405")
		log.Printf("index.json 解析失败，已改名留档 %s: %v", bad, err)
		return os.Rename(s.indexPath(), bad)
	}
	items := make(map[int]*RefItem, len(idx.Items))
	for _, it := range idx.Items {
		// 手改坏的行直接跳过：宁可少一条编号，也不想让一条没有路径的表项占着号
		if it == nil || it.Ref < 1 || it.Path == "" {
			continue
		}
		items[it.Ref] = it
	}
	s.mu.Lock()
	s.items = items
	s.mu.Unlock()
	return nil
}

// saveLocked 原子写 index.json：先写同目录的临时文件，再 rename 覆盖。
// 直接截断重写的话，进程死在写一半会留下半截索引，比丢一次更新更难收拾；
// rename 在同一文件系统内是原子的，读到的只会是完整的一版。
func (s *Store) saveLocked() error {
	buf, err := json.Marshal(indexFile{Items: s.sortedLocked()})
	if err != nil {
		return err
	}
	if err := os.MkdirAll(s.refsDir(), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(s.refsDir(), "index-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	// rename 成功之后这一下删不到东西，只有失败路径上才真的清掉半成品
	defer os.Remove(name)

	if _, err := tmp.Write(append(buf, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, s.indexPath())
}

// sortedLocked 返回按编号升序排列的副本。给出去的是副本：调用方只读，
// 改了也不会回头污染表里那条（回收顺序就靠这些时间字段）。
func (s *Store) sortedLocked() []*RefItem {
	out := make([]*RefItem, 0, len(s.items))
	for _, it := range s.items {
		out = append(out, it.clone())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Ref < out[j].Ref })
	return out
}

// Refs 是给页面和 pi 看的全表，按编号升序。要按编号念给人听，顺序稳定比快重要。
func (s *Store) Refs() []*RefItem {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sortedLocked()
}

func (s *Store) Get(ref int) (*RefItem, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	it, ok := s.items[ref]
	if !ok {
		return nil, errNoRef
	}
	return it.clone(), nil
}

// Touch 把编号刷成「刚用过」。它是回收顺序的唯一输入，所以刷完必须落盘：
// 只记在内存里的话，重启之后这些使用记录就没了，回收会开始按入库时间乱砍。
func (s *Store) Touch(ref int) (*RefItem, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	it, ok := s.items[ref]
	if !ok {
		return nil, errNoRef
	}
	prev := it.LastUsed
	it.LastUsed = rfc3339(time.Now())
	if err := s.saveLocked(); err != nil {
		it.LastUsed = prev
		return nil, err
	}
	return it.clone(), nil
}

// Delete 删掉编号对应的图片文件，并摘掉表项把号还回池子（后续上传会重用这个号）。
//
// 文件路径只从编号表里取，绝不拿请求参数拼：/refs/<n>/delete 里的 <n> 只用来查表，
// 所以这个接口能删的东西严格限定在「表里登记的、且那个号指向的文件」，
// archive/ 里别的文件或任意路径都碰不到。
//
// 表项摘除与文件删除的顺序：先删文件、再摘表。反过来的话，摘完表删文件失败就丢了
// 一条记录，文件成了没人认领的孤儿；这个顺序下最坏是文件已删、表还在，用户再看一眼
// 还看得到这条，重试一次就清了。
func (s *Store) Delete(ref int) (*RefItem, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	it, ok := s.items[ref]
	if !ok {
		return nil, errNoRef
	}
	if !s.insideArchive(it.Path) {
		return nil, fmt.Errorf("%w: %s", errOutside, it.Path)
	}
	if err := os.Remove(it.Path); err != nil {
		if !os.IsNotExist(err) {
			// 权限、忙之类的真失败：文件没动，表也不动，编号还留着，用户至少还看得到它
			return nil, err
		}
		// 文件本来就不在：表里这条已经是空壳，编号一样要还回去，只是告诉调用方 404
		if err := s.dropLocked(ref, it); err != nil {
			return nil, err
		}
		return nil, errNoFile
	}
	if err := s.dropLocked(ref, it); err != nil {
		return nil, err
	}
	return it.clone(), nil
}

// dropLocked 摘掉一条表项并落盘，写盘失败就放回来。
// 索引是编号表的唯一事实来源，只在内存里删等于重启后编号又回来了。
func (s *Store) dropLocked(ref int, it *RefItem) error {
	delete(s.items, ref)
	if err := s.saveLocked(); err != nil {
		s.items[ref] = it
		return err
	}
	return nil
}

// insideArchive 判断表里的路径确实落在 archive/ 里。用 Rel 加前缀判断而不是字符串
// HasPrefix：HasPrefix("/a/b", "/a/bc") 也会为真，那种写法放进删除路径就是隐患。
//
// 只认 archive/ 之下：图片本来就只落在那里。表被手改成指向 state 里的别的东西
// （比如 refs/index.json）甚至指向 state 目录本身时，删除应当拒绝，而不是照着删。
func (s *Store) insideArchive(path string) bool {
	rel, err := filepath.Rel(filepath.Join(s.root, "archive"), path)
	if err != nil || rel == "." || filepath.IsAbs(rel) {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// Enqueue 把一张图落进 archive/YYYYMMDD/ 并分配一个短编号。
// mime 不在表里就拒收、不落盘：落一张扩展名和内容对不上的文件，
// 后面每个读它的人都要多判一次。
func (s *Store) Enqueue(mime string, data []byte) (*RefItem, error) {
	ext, ok := mimeExt[mime]
	if !ok {
		return nil, errUnknownMime
	}
	if len(data) == 0 {
		return nil, errEmptyImage
	}
	now := time.Now()
	dir := filepath.Join(s.root, "archive", now.Format("20060102"))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, newItemID(now)+ext)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return nil, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	prev := s.snapshotLocked()
	ref, evicted := s.allocLocked()
	if ref < 1 {
		s.items = prev
		return nil, errNoFreeRef
	}
	it := &RefItem{Ref: ref, Path: path, Bytes: int64(len(data)), TS: rfc3339(now)}
	s.items[ref] = it
	if err := s.saveLocked(); err != nil {
		// 索引没写成就当没登记过。图片文件留在 archive：内容本身是真的，
		// 删了不可逆；用户下次还能拿绝对路径找到它。
		log.Printf("编号表写盘失败，%s 未登记（文件保留）: %v", path, err)
		s.items = prev
		return nil, err
	}
	if evicted != nil {
		log.Printf("编号池满：%d 号让给新图，原图仍在 %s", evicted.Ref, evicted.Path)
	}
	return it.clone(), nil
}

// snapshotLocked 浅拷贝一张表，用于写盘失败时回滚。
// 浅拷贝够用：分配只做插入和删除，不会改到 RefItem 内部。
func (s *Store) snapshotLocked() map[int]*RefItem {
	m := make(map[int]*RefItem, len(s.items))
	for k, v := range s.items {
		m[k] = v
	}
	return m
}

// allocLocked 分配编号：1..pool 里最小的空号；一个空号都没有时，回收 lastUsed 最早
// 的那条（没 lastUsed 看 ts）把号让出来。
//
// 池调小之后留下的越界编号不参与回收：它们既不是空号，也不该被当成候选砍掉。
func (s *Store) allocLocked() (ref int, evicted *RefItem) {
	for r := 1; r <= s.pool; r++ {
		if _, ok := s.items[r]; !ok {
			return r, nil
		}
	}
	// 池满。时间相同时按编号小的先走，免得同一批图在池满时回收谁随 map 遍历顺序变。
	victim := 0
	var victimAt time.Time
	for r, it := range s.items {
		if r > s.pool {
			continue
		}
		at := it.evictKey()
		if victim == 0 || at.Before(victimAt) || (at.Equal(victimAt) && r < victim) {
			victim, victimAt = r, at
		}
	}
	if victim == 0 {
		return 0, nil // 走不到：池 ≥ 1，池满时必然有候选
	}
	evicted = s.items[victim]
	delete(s.items, victim)
	return victim, evicted
}

// newItemID 形如 1758859200123-0007-a1b2c3d4：毫秒时间戳在前，文件名排序就是
// 拍摄顺序；同毫秒内再垫一个自增序号，否则同一批上传的几张图在重启后会按随机后缀
// 重排。id 只是文件名，编号与它的对应关系在 refs/index.json 里。
func newItemID(t time.Time) string {
	var b [4]byte
	_, _ = rand.Read(b[:])
	return fmt.Sprintf("%013d-%04d-%s", t.UnixMilli(), itemSeq.Add(1)%10000, hex.EncodeToString(b[:]))
}
