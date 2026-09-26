package main

import (
	"context"
	"encoding/binary"
	"errors"
	"log"
	"os"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

// 「用户还在不在电脑前」的信号来自 evdev（/dev/input/event*）。hub 只需要一个粗信号，
// 用来决定审批卡要不要压一压再推，所以这里不建事件队列、不留历史，只记最后一次键击时刻。

const (
	// inputEventSize 是 Linux 64 位 struct input_event 的长度：
	// timeval（两个 int64）+ uint16 type + uint16 code + int32 value。
	inputEventSize = 24
	// 只有 EV_KEY 算用户活动。EV_REL（鼠标漂移）与 EV_SYN（同步包）一律忽略：
	// 用户的鼠标本来就一直在自己漂，把它们算成活动，这个信号就永远显示「刚活动过」。
	evSyn = 0
	evKey = 1
	evRel = 2

	inputDevicesPath = "/proc/bus/input/devices"
	inputDeviceDir   = "/dev/input/"

	// inputRescanEvery 是设备表重扫周期。键盘按开机顺序出现，hub 常驻，
	// 只扫一次就会漏掉后插的键鼠，那台设备上的按键从此不再算活动。
	inputRescanEvery = 30 * time.Second
)

// parseInputEvent 从一条 24 字节里取出 type / code / value。
// 手工用 encoding/binary 解析，不走 unsafe：结构体对齐随架构变，
// 直接读内存的话这段代码的正确性就跟着编译目标变了。
func parseInputEvent(b []byte) (evType, code uint16, value int32, ok bool) {
	if len(b) < inputEventSize {
		return 0, 0, 0, false
	}
	evType = binary.LittleEndian.Uint16(b[16:18])
	code = binary.LittleEndian.Uint16(b[18:20])
	value = int32(binary.LittleEndian.Uint32(b[20:24]))
	return evType, code, value, true
}

// inputDevice 是 /proc/bus/input/devices 里一个挂了 kbd / mouse 的条目。
type inputDevice struct {
	Name string
	Path string
}

// scanInputDevices 解析设备表，返回值得监听的 event 节点。
// Name 与 Handlers 必须按条目配对：文件是空行分块的，同一块的 H 行只描述该块的设备，
// 跨块去取 Handlers 会把别的设备（摄像头、手柄）算成键鼠。
func scanInputDevices(path string) ([]inputDevice, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var out []inputDevice
	var name, handlers string
	flush := func() {
		if p, ok := inputEventPath(handlers); ok {
			out = append(out, inputDevice{Name: name, Path: p})
		}
		name, handlers = "", ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) == "" {
			flush()
			continue
		}
		switch {
		case strings.HasPrefix(line, "N: Name="):
			name = strings.Trim(strings.TrimPrefix(line, "N: Name="), `"`)
		case strings.HasPrefix(line, "H: Handlers="):
			handlers = strings.TrimSpace(strings.TrimPrefix(line, "H: Handlers="))
		}
	}
	flush()
	// 排序只为让日志与测试的输出稳定；遍历顺序本身对结果没影响。
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, nil
}

// inputEventPath 从 Handlers 行里挑出 event 节点。按空白切词、整词比较，
// 不用词边界正则：mouse0 里 mouse 后面紧跟数字，\b 认不出它是鼠标那一路。
func inputEventPath(handlers string) (string, bool) {
	var node string
	keyboard := false
	for _, tok := range strings.Fields(handlers) {
		switch {
		case tok == "kbd", strings.HasPrefix(tok, "mouse"):
			keyboard = true
		case strings.HasPrefix(tok, "event"):
			node = inputDeviceDir + tok
		}
	}
	if !keyboard || node == "" {
		return "", false
	}
	return node, true
}

// inputTracker 维护「最后一次键鼠活动」的状态。now 可注入，测试不需要真实时钟。
type inputTracker struct {
	mu       sync.Mutex
	now      func() time.Time
	base     time.Time       // 启动时刻：从未有活动时的基准
	lastKey  time.Time       // 最后一次 EV_KEY 活动
	seen     map[string]bool // 已起过读取 goroutine 的设备，防止重复起
	reading  map[string]bool // 当前真正打开着、可读的设备
	notified map[string]bool // 已经报过打开失败的设备，同一台只报一次
}

func newInputTracker(now func() time.Time) *inputTracker {
	if now == nil {
		now = time.Now
	}
	return &inputTracker{
		now:      now,
		base:     now(),
		seen:     map[string]bool{},
		reading:  map[string]bool{},
		notified: map[string]bool{},
	}
}

// consume 从一段原始 evdev 字节里挑出用户活动。不足一条事件长度的尾巴直接丢掉：
// 那多半是被截断的读取，补零凑一条假事件会把一次不存在的按键记成活动。
func (t *inputTracker) consume(b []byte) {
	hit := false
	for off := 0; off+inputEventSize <= len(b); off += inputEventSize {
		evType, _, value, ok := parseInputEvent(b[off : off+inputEventSize])
		if !ok {
			continue
		}
		if evType == evKey && value != 0 {
			hit = true
		}
	}
	if !hit {
		return
	}
	t.mu.Lock()
	t.lastKey = t.now()
	t.mu.Unlock()
}

// Idle 返回距最后一次键击的时长，以及本机是否存在可读的键鼠设备。
// 从未收到过活动时以启动时刻为基准：返回 0 会让调用方以为用户刚刚按了键。
func (t *inputTracker) Idle() (time.Duration, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	from := t.lastKey
	if from.IsZero() {
		from = t.base
	}
	d := t.now().Sub(from)
	if d < 0 {
		// 时钟回拨时按「刚刚活动过」算：负的 idle 会让调用方的比较整个反掉
		d = 0
	}
	return d, len(t.reading) > 0
}

func (t *inputTracker) setReading(path string, ok bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if ok {
		t.reading[path] = true
		return
	}
	delete(t.reading, path)
}

// claimDevice 标记设备已被接手；返回 false 表示早就起过，别重复起。
func (t *inputTracker) claimDevice(path string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.seen[path] {
		return false
	}
	t.seen[path] = true
	return true
}

func (t *inputTracker) releaseDevice(path string) {
	t.mu.Lock()
	delete(t.seen, path)
	delete(t.reading, path)
	t.mu.Unlock()
}

// notifyOnce 报告一台设备只报一次：权限问题会让每一轮重扫都失败，
// 常驻进程每 30 秒往 journal 里刷一条同样的错误没有意义。
func (t *inputTracker) notifyOnce(path string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.notified[path] {
		return false
	}
	t.notified[path] = true
	return true
}

// Run 在后台维护设备列表与读取 goroutine，直到 ctx 结束。
func (t *inputTracker) Run(ctx context.Context, devicesPath string, every time.Duration) {
	if every <= 0 {
		every = inputRescanEvery
	}
	t.scanOnce(ctx, devicesPath)
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			t.scanOnce(ctx, devicesPath)
		}
	}
}

// scanOnce 扫一次设备表，为新出现的键鼠起读取 goroutine。
func (t *inputTracker) scanOnce(ctx context.Context, devicesPath string) {
	devices, err := scanInputDevices(devicesPath)
	if err != nil {
		// 设备表读不到（非 Linux、或没权限）就等于本机没有可读键鼠，按 false 报出去，
		// 调用方会保守处理。这里不写日志：常驻进程每 30 秒一条会盖满 journal。
		return
	}
	for _, dev := range devices {
		if !t.claimDevice(dev.Path) {
			continue
		}
		go t.readDevice(ctx, dev)
	}
}

// readDevice 读一个 event 设备上的原始事件，直到出错退出。
// 退出时把设备交还给重扫：设备拔了再插回来路径通常不变，
// 不释放的话下一轮扫到它也不会重新起读取。
func (t *inputTracker) readDevice(ctx context.Context, dev inputDevice) {
	f, err := os.Open(dev.Path)
	if err != nil {
		// 打不开就把设备交还给重扫（可能是热插拔刚换节点那一刻的失败），
		// 但错误只报一次。
		if t.notifyOnce(dev.Path) {
			log.Printf("presence: 打不开 %s: %v", dev.Path, err)
		}
		t.releaseDevice(dev.Path)
		return
	}
	defer f.Close()
	t.setReading(dev.Path, true)
	defer t.releaseDevice(dev.Path)
	log.Printf("presence: 监听 %s (%s)", dev.Path, dev.Name)

	buf := make([]byte, inputEventSize*32)
	for {
		if ctx.Err() != nil {
			return
		}
		n, err := f.Read(buf)
		if n > 0 {
			t.consume(buf[:n])
		}
		if err != nil {
			// EINTR 只是被信号打断，接着读；其余（ENODEV、EOF）退出去让重扫重来
			if errors.Is(err, syscall.EINTR) {
				continue
			}
			return
		}
	}
}
