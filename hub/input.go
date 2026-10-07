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
// 用来决定审批卡要不要压一压再推：键击直接算活动，鼠标位移要过一遍 noteRel 的窗口判定，
// 把「鼠标自己在漂 / 在抖 / 顶在屏幕边上」这类不算人用的位移挡掉。
// 全程事件驱动：不建事件队列、不起定时器、不做后台统计，只在事件到来时增量更新状态。

const (
	// inputEventSize 是 Linux 64 位 struct input_event 的长度：
	// timeval（两个 int64）+ uint16 type + uint16 code + int32 value。
	inputEventSize = 24
	// EV_SYN（同步包）继续忽略：它是分包的边界，本身不含位移。
	// EV_KEY（按下后 value != 0）算活动；EV_REL（鼠标相对位移）走 noteRel 判定。
	evSyn = 0
	evKey = 1
	evRel = 2
	// REL_X / REL_Y 是鼠标的两轴相对位移，进窗口判定。
	relX = 0
	relY = 1
	// REL_HWHEEL / REL_WHEEL 是滚轮。它们不进窗口：那几条判据看的是像素位移的形状，
	// 滚轮的一格不是位移。但滚轮不会自己滚，有非零值就说明有人，直接算活动。
	relHWheel = 6
	relWheel  = 8

	// 鼠标位移的判定窗口与阈值。一次移动像不像人在用，看的不是单条 delta，
	// 而是这 2 秒里位移的形状：原地抖动净位移趋零，缓慢漂移总量太小，撞边一路同向。
	// 窗口取 2 秒是个折中：够短，人走开之后能很快显出来；够长，抖动与撞边的形态才成型。
	relWindow = 2 * time.Second
	// relMinTotal 是窗口内的最小总位移：低于它多半是鼠标硬件 / 桌面的缓慢漂移。
	relMinTotal = 30
	// relEdgeTotal 是撞边判定的位移门槛：位移量远大于屏幕尺寸，说明不是一次甩动，
	// 而是推到头之后传感器还在报同方向。
	relEdgeTotal = 200
	// relMinSamples 是判活动所需的最小样本数：一条 delta 看不出形状。
	relMinSamples = 2

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

// relSample 是窗口里的一条相对位移样本。dx / dy 分开留着：总量看两轴之和，
// 撞边判定只看 dx 有没有反向。
type relSample struct {
	t      time.Time
	dx, dy int32
}

// inputTracker 维护「最后一次有效用户活动」的状态。now 可注入，测试不需要真实时钟。
type inputTracker struct {
	mu         sync.Mutex
	now        func() time.Time
	base       time.Time // 启动时刻：从未有活动时的基准
	lastActive time.Time // 最后一次有效活动（键击，或判定为人在用的鼠标位移）
	// relSamples 是 relWindow 内的鼠标位移样本，按时间递增；relTotal / relSX / relSY
	// 是它们的增量统计（总位移、两轴的带符号和）。三段状态只在收到 EV_REL 时更新：
	// 追加新样本、从头部丢掉过期样本，顺手把过期样本的贡献减掉。每条样本只进出
	// 各一次，所以每个事件的代价摊还是常数，不用定期回头扫历史。
	relSamples []relSample
	relTotal   int64
	relSX      int64
	relSY      int64
	seen       map[string]bool // 已起过读取 goroutine 的设备，防止重复起
	reading    map[string]bool // 当前真正打开着、可读的设备
	notified   map[string]bool // 已经报过打开失败的设备，同一台只报一次
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
	// 一次读取里的事件最多差几毫秒，整批按同一个时刻算：逐条取时钟只是多几次调用
	now := t.now()
	hit := false
	for off := 0; off+inputEventSize <= len(b); off += inputEventSize {
		evType, code, value, ok := parseInputEvent(b[off : off+inputEventSize])
		if !ok {
			continue
		}
		switch evType {
		case evKey:
			if value != 0 {
				hit = true
			}
		case evRel:
			// 滚轮没有「自己滚」这回事，一转就是人在用，不需要窗口判定
			if code == relWheel || code == relHWheel {
				if value != 0 {
					hit = true
				}
				continue
			}
			// 鼠标位移不是「来了就算」，要看 2 秒窗口里攒出来的形状
			if t.noteRel(code, value, now) {
				hit = true
			}
		}
	}
	if !hit {
		return
	}
	t.mu.Lock()
	t.lastActive = now
	t.mu.Unlock()
}

// 滚轮在 consume 里就直接算活动，不走 noteRel。
//
// noteRel 收一条 EV_REL 样本，返回这次位移是否像人在用。判定用 relWindow 内的增量统计：
//
//	total = Σ(|dx|+|dy|)   窗口内总位移
//	net   = |Σdx| + |Σdy|  净位移
//
// total < 30 不算活动（缓慢漂移攒不出这个量）；net/total < 0.25 不算活动（原地抖动来回
// 相抵）；窗口里的 dx 一路同向、total > 200、且样本跨越整个窗口时也不算活动（撞边）。
// 撞边那三条必须同时成立：人快速甩鼠标也是同向的，单独一次甩动够不着「跨越整个窗口」。
//
// 这里维护的是窗口的形状，不是事件流水：样本过期即丢，过期样本的贡献当场从统计里减掉，
// 所以既没有历史队列，也没有周期性重扫。
func (t *inputTracker) noteRel(code uint16, value int32, now time.Time) bool {
	var s relSample
	switch code {
	case relX:
		s = relSample{t: now, dx: value}
	case relY:
		s = relSample{t: now, dy: value}
	default:
		return false
	}

	t.mu.Lock()
	defer t.mu.Unlock()

	cutoff := now.Add(-relWindow)
	// 「跨越整个窗口」= 窗口起点那里还有样本，也就是这 2 秒里传感器一直在报。
	// 这一判要在丢弃过期样本之前做：丢完之后最老的样本一定落在窗口内，
	// 就永远判不出「跨越」了。一次甩动只留下几百毫秒的样本，够不着窗口起点。
	spanned := len(t.relSamples) > 0 && !t.relSamples[0].t.After(cutoff)
	// 从头部丢掉过期样本，顺手把它们的贡献减掉。每条样本只会被丢一次，
	// 摊到每个事件是常数代价，不需要每 2 秒重扫一遍历史。
	drop := 0
	for drop < len(t.relSamples) && !t.relSamples[drop].t.After(cutoff) {
		old := t.relSamples[drop]
		t.relTotal -= absNum(old.dx) + absNum(old.dy)
		t.relSX -= int64(old.dx)
		t.relSY -= int64(old.dy)
		drop++
	}
	t.relSamples = t.relSamples[drop:]
	t.relSamples = append(t.relSamples, s)
	t.relTotal += absNum(s.dx) + absNum(s.dy)
	t.relSX += int64(s.dx)
	t.relSY += int64(s.dy)

	if len(t.relSamples) < relMinSamples {
		return false // 一条 delta 看不出形状
	}
	if t.relTotal < relMinTotal {
		return false // 缓慢漂移
	}
	net := absNum(t.relSX) + absNum(t.relSY)
	if net*4 < t.relTotal { // net/total < 0.25
		return false // 原地抖动：来回都记进 total，净位移翻不起来
	}
	if spanned && t.relTotal > relEdgeTotal && noReverseX(t.relSamples) {
		return false // 撞边：推到头之后传感器还在同方向报，位移远超屏幕尺寸
	}
	return true
}

// noReverseX 判断窗口内的 dx 是不是一路同向（0 不算反向）。
// 内核把 X / Y 拆成两条事件，水平移动时夹在中间的 dx = 0 那一溜属于同一段运动，
// 把它们当成反向，撞边就整个漏掉了。
func noReverseX(samples []relSample) bool {
	pos, neg := false, false
	for _, s := range samples {
		switch {
		case s.dx > 0:
			pos = true
		case s.dx < 0:
			neg = true
		}
	}
	return !(pos && neg)
}

// absNum 是整数绝对值，一律返回 int64。总位移是各分量绝对值之和，
// 不能拿带符号的和直接取绝对值。写成泛型是因为样本分量是 int32、窗口统计是 int64。
func absNum[T int32 | int64](v T) int64 {
	if v < 0 {
		return -int64(v)
	}
	return int64(v)
}

// Idle 返回距最后一次有效活动的时长，以及本机是否存在可读的键鼠设备。
// 从未收到过活动时以启动时刻为基准：返回 0 会让调用方以为用户刚刚按了键。
// 求值是懒的：被调用时读一眼已有状态，不在这里推进窗口。
func (t *inputTracker) Idle() (time.Duration, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	from := t.lastActive
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
