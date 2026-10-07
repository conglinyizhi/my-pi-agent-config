package main

import (
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeClock 是可手动推进的时钟。presence 的断言横跨 hub 的 handler goroutine，
// 直接改一个共享的 time.Time 变量会在 -race 下报数据竞争。
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func newFakeClock(t time.Time) *fakeClock { return &fakeClock{t: t} }

func (c *fakeClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

// encodeInputEvent 造一条 24 字节的 input_event。前 16 字节是 timeval，
// tracker 不看它，留零。
func encodeInputEvent(evType, code uint16, value int32) []byte {
	b := make([]byte, inputEventSize)
	binary.LittleEndian.PutUint16(b[16:18], evType)
	binary.LittleEndian.PutUint16(b[18:20], code)
	binary.LittleEndian.PutUint32(b[20:24], uint32(value))
	return b
}

// feedRelX 按固定的间隔喂一串 REL_X 样本，模拟鼠标连续报位移，返回最后一个样本的时刻。
// 走的是和生产路径一样的入口（consume 的原始字节），只是时钟由测试推进。
func feedRelX(tr *inputTracker, clk *fakeClock, gap time.Duration, dxs ...int32) time.Time {
	var last time.Time
	for _, dx := range dxs {
		clk.advance(gap)
		last = clk.now()
		tr.consume(encodeInputEvent(evRel, relX, dx))
	}
	return last
}

// sameFrames 造 n 帧同方向位移。
func sameFrames(n int, dx int32) []int32 {
	out := make([]int32, n)
	for i := range out {
		out[i] = dx
	}
	return out
}

// EV_KEY 按下（value != 0）算活动，EV_SYN 一律不算；单条 EV_REL 样本看不出形状，
// 也还不算。鼠标位移的判定用例见下面几组 TestInputRel*。
func TestInputCountsKeyPress(t *testing.T) {
	start := time.Date(2026, 4, 8, 12, 0, 0, 0, time.UTC)
	keyPress := encodeInputEvent(evKey, 30, 1) // KEY_A 按下
	cases := []struct {
		name    string
		payload []byte
		active  bool
	}{
		{"EV_KEY 按下", keyPress, true},
		{"EV_KEY 长按重复", encodeInputEvent(evKey, 30, 2), true},
		{"EV_KEY 抬起", encodeInputEvent(evKey, 30, 0), false},
		{"EV_REL 单条样本", encodeInputEvent(evRel, relX, 5), false},
		{"EV_SYN 同步包", encodeInputEvent(evSyn, 0, 0), false},
		{"长度不足一条事件", keyPress[:inputEventSize-1], false},
		{"空读", nil, false},
		{"按下之后再跟半条残渣", append(append([]byte{}, keyPress...), keyPress[:7]...), true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			clk := newFakeClock(start)
			tr := newInputTracker(clk.now)
			clk.advance(time.Second)
			tr.consume(tc.payload) // 长度不足时不许 panic
			clk.advance(500 * time.Millisecond)
			idle, _ := tr.Idle()
			want := 1500 * time.Millisecond // 没记活动：从启动时刻算
			if tc.active {
				want = 500 * time.Millisecond // 记在消费那一刻
			}
			if idle != want {
				t.Fatalf("idle=%v want %v", idle, want)
			}
		})
	}
}

// 真划鼠标算活动：100 毫秒里向右甩出 300 像素，净位移等于总位移。
// 同向、位移量也过了 relEdgeTotal，但没跨越整个窗口，不能被撞边那一条误伤。
func TestInputRelCountsSwipe(t *testing.T) {
	clk := newFakeClock(time.Date(2026, 4, 8, 12, 0, 0, 0, time.UTC))
	tr := newInputTracker(clk.now)

	feedRelX(tr, clk, 10*time.Millisecond, sameFrames(10, 30)...)
	clk.advance(250 * time.Millisecond)
	if idle, _ := tr.Idle(); idle != 250*time.Millisecond {
		t.Fatalf("划动的最后一帧该算活动，idle=%v want 250ms", idle)
	}
}

// 滚轮算活动：它没有「自己滚」这回事，一转就是人在用，不走窗口判定。
// 样本量刻意压在 relMinSamples / relMinTotal 之下：要是错误地把它送进窗口，
// 会因为「一条 delta 看不出形状」被判成不算活动，这个用例就会挂。
func TestInputRelCountsWheel(t *testing.T) {
	clk := newFakeClock(time.Date(2026, 4, 8, 12, 0, 0, 0, time.UTC))
	tr := newInputTracker(clk.now)

	clk.advance(10 * time.Millisecond)
	tr.consume(encodeInputEvent(evRel, relWheel, 1)) // 向下滚一格
	clk.advance(120 * time.Millisecond)
	if idle, _ := tr.Idle(); idle != 120*time.Millisecond {
		t.Fatalf("滚轮该算活动，idle=%v want 120ms", idle)
	}
}

// 滚轮的 value = 0 是事件序列里的空转（内核偶尔发一条），不该算活动。
func TestInputRelIgnoresZeroWheel(t *testing.T) {
	clk := newFakeClock(time.Date(2026, 4, 8, 12, 0, 0, 0, time.UTC))
	tr := newInputTracker(clk.now)

	clk.advance(10 * time.Millisecond)
	tr.consume(encodeInputEvent(evRel, relWheel, 0))
	clk.advance(3 * time.Second)
	// 一共过了 3.01 秒；从启动时刻算起，那条 value=0 的事件没有把基准往前推
	if idle, _ := tr.Idle(); idle != 3*time.Second+10*time.Millisecond {
		t.Fatalf("value=0 的滚轮事件不该算活动，idle=%v want 3.01s", idle)
	}
}

// 原地抖动不算活动：来回 ±5 像素，总位移攒得起来，净位移始终趋零。
// 前几帧是样本太少 / 总量太小（relMinSamples、relMinTotal），从第 6 帧起靠的是
// 净位移比例那一判：total 过了 30，net/total 只有 1/6 上下。
func TestInputRelIgnoresJitter(t *testing.T) {
	clk := newFakeClock(time.Date(2026, 4, 8, 12, 0, 0, 0, time.UTC))
	tr := newInputTracker(clk.now)

	frames := make([]int32, 0, 40)
	for i := range 40 {
		if i%2 == 0 {
			frames = append(frames, 5)
		} else {
			frames = append(frames, -5)
		}
	}
	last := feedRelX(tr, clk, 20*time.Millisecond, frames...)

	// 一帧都没算成活动：idle 从启动时刻算起，等于全程时长
	if idle, _ := tr.Idle(); idle != last.Sub(tr.base) {
		t.Fatalf("抖动不该算活动，idle=%v want %v", idle, last.Sub(tr.base))
	}
}

// 缓慢漂移不算活动：每帧 1 像素、100 毫秒一帧，2 秒窗口里最多攒到 20 出头，
// 够不着 relMinTotal。
func TestInputRelIgnoresSlowDrift(t *testing.T) {
	clk := newFakeClock(time.Date(2026, 4, 8, 12, 0, 0, 0, time.UTC))
	tr := newInputTracker(clk.now)

	last := feedRelX(tr, clk, 100*time.Millisecond, sameFrames(30, 1)...)

	if idle, _ := tr.Idle(); idle != last.Sub(tr.base) {
		t.Fatalf("漂移不该算活动，idle=%v want %v", idle, last.Sub(tr.base))
	}
}

// 撞边不算活动：推到屏幕边上卡住，传感器还在同方向报，一报就是几秒。
// 这里 20 毫秒一帧、每帧 10 像素，total 与净位移都远超门槛，全靠「样本跨越整个窗口」
// 这一条挡住：第 2.02 秒窗口里第一次出现够老的样本，那帧起就不再算活动。
func TestInputRelIgnoresEdgePush(t *testing.T) {
	clk := newFakeClock(time.Date(2026, 4, 8, 12, 0, 0, 0, time.UTC))
	tr := newInputTracker(clk.now)

	feedRelX(tr, clk, 20*time.Millisecond, sameFrames(101, 10)...)
	// 最后一次活动停在 2 秒整那帧（撞边那三条还没凑齐），撞边那帧不再刷新
	if idle, _ := tr.Idle(); idle != 20*time.Millisecond {
		t.Fatalf("撞边不该算活动，idle=%v want 20ms", idle)
	}

	// 继续顶着不动，活动时刻就一直是那一次
	feedRelX(tr, clk, 20*time.Millisecond, sameFrames(50, 10)...)
	if idle, _ := tr.Idle(); idle != time.Second+20*time.Millisecond {
		t.Fatalf("持续撞边不该刷新活动时刻，idle=%v want 1.02s", idle)
	}
}

// 窗口外的老样本要被丢掉：判定看的是窗口，不是开机以来的累计。
// 老样本取一段总量不超过 relEdgeTotal 的反向划动，这样「只丢样本不减统计」和
// 「什么都不丢」两种写法都会把后面那两条 1 像素的漂移抬成活动，测试才咬得住。
func TestInputRelDropsSamplesOutsideWindow(t *testing.T) {
	clk := newFakeClock(time.Date(2026, 4, 8, 12, 0, 0, 0, time.UTC))
	tr := newInputTracker(clk.now)

	// 先向左划一段（这段本身算活动），随后停 3 秒，让它整个滑出窗口
	activeAt := feedRelX(tr, clk, 10*time.Millisecond, sameFrames(4, -40)...)
	if idle, _ := tr.Idle(); idle != 0 {
		t.Fatalf("向左划该算活动，idle=%v", idle)
	}

	clk.advance(3 * time.Second)
	feedRelX(tr, clk, 100*time.Millisecond, 1, 1)
	clk.advance(time.Second)

	// 窗口里只剩那两条 1 像素的样本（total = 2 < relMinTotal），活动时刻不该被刷新
	if idle, _ := tr.Idle(); idle != clk.now().Sub(activeAt) {
		t.Fatalf("窗口外的老样本必须丢掉，idle=%v want %v", idle, clk.now().Sub(activeAt))
	}
}

// 从未收到活动时以启动时刻为基准：返回 0 会被调用方当成「用户刚刚在动」。
func TestInputIdleBaselineIsStart(t *testing.T) {
	start := time.Date(2026, 4, 8, 12, 0, 0, 0, time.UTC)
	clk := newFakeClock(start)
	tr := newInputTracker(clk.now)

	if idle, _ := tr.Idle(); idle != 0 {
		t.Fatalf("刚起就该是 0，得到 %v", idle)
	}
	clk.advance(2 * time.Minute)
	idle, hasInput := tr.Idle()
	if idle != 2*time.Minute {
		t.Fatalf("没有活动时应以 tracker 启动时刻为基准，得到 %v", idle)
	}
	if hasInput {
		t.Fatal("没有设备时 hasInput 应为 false")
	}
}

// 时钟被往回拨时按「刚刚活动过」算，负的 idle 会让调用方的比较整个反掉。
func TestInputIdleClampsClockBackwards(t *testing.T) {
	start := time.Date(2026, 4, 8, 12, 0, 0, 0, time.UTC)
	clk := newFakeClock(start)
	tr := newInputTracker(clk.now)
	clk.advance(time.Minute)
	tr.consume(encodeInputEvent(evKey, 30, 1))
	clk.advance(-30 * time.Second)
	if idle, _ := tr.Idle(); idle != 0 {
		t.Fatalf("idle=%v", idle)
	}
}

func TestInputHasInputFollowsReadableDevices(t *testing.T) {
	tr := newInputTracker(nil)
	if _, hasInput := tr.Idle(); hasInput {
		t.Fatal("还没读任何设备时 hasInput 应为 false")
	}
	tr.setReading("/dev/input/event4", true)
	if _, hasInput := tr.Idle(); !hasInput {
		t.Fatal("有可读设备时 hasInput 应为 true")
	}
	tr.setReading("/dev/input/event4", false)
	if _, hasInput := tr.Idle(); hasInput {
		t.Fatal("设备读不动了 hasInput 要跟着回 false")
	}
}

// 设备表按空行分块，Name 与 Handlers 必须同块配对；只有挂了 kbd / mouse 的才监听。
func TestScanInputDevices(t *testing.T) {
	table := `I: Bus=0019 Vendor=0000 Product=0001 Version=0000
N: Name="Power Button"
P: Phys=PNP0C0C/button/input0
H: Handlers=kbd event0
B: PROP=0

I: Bus=0003 Vendor=1c4f Product=0034 Version=0110
N: Name="SIGMACHIP Usb Mouse"
H: Handlers=event2 mouse0
B: PROP=0

I: Bus=0003 Vendor=046d Product=085c Version=0111
N: Name="HD Pro Webcam C920"
H: Handlers=event9
B: PROP=0

H: Handlers=kbd event5
N: Name="AT Translated Set 2 keyboard"

`
	path := filepath.Join(t.TempDir(), "devices")
	if err := os.WriteFile(path, []byte(table), 0o600); err != nil {
		t.Fatal(err)
	}
	devices, err := scanInputDevices(path)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, d := range devices {
		got = append(got, d.Path+"="+d.Name)
	}
	want := []string{
		"/dev/input/event0=Power Button",
		"/dev/input/event2=SIGMACHIP Usb Mouse",
		"/dev/input/event5=AT Translated Set 2 keyboard",
	}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Fatalf("设备发现结果不对\n got %v\nwant %v", got, want)
	}
}

// Handlers 里的 mouse0 后面紧跟数字，词边界匹配会漏；按空白切词整词比较才认得出。
func TestInputEventPath(t *testing.T) {
	cases := []struct {
		handlers string
		want     string
	}{
		{"kbd event4", "/dev/input/event4"},
		{"event2 mouse0", "/dev/input/event2"},
		{"sysrq kbd leds event3", "/dev/input/event3"},
		{"mouse event1", "/dev/input/event1"},
		{"event9", ""},
		{"kbd", ""},
		{"", ""},
	}
	for _, tc := range cases {
		t.Run(tc.handlers, func(t *testing.T) {
			got, ok := inputEventPath(tc.handlers)
			if tc.want == "" {
				if ok {
					t.Fatalf("%q 不该被监听，得到 %s", tc.handlers, got)
				}
				return
			}
			if !ok || got != tc.want {
				t.Fatalf("%q -> %q (ok=%v)，want %q", tc.handlers, got, ok, tc.want)
			}
		})
	}
}

// 设备热插拔靠这组账：同一台设备不能重复起读取 goroutine；
// 读取退出后要交还认领，否则拔了再插（路径通常不变）就再也起不来了。
func TestInputDeviceClaimLifecycle(t *testing.T) {
	tr := newInputTracker(nil)
	const path = "/dev/input/event4"
	if !tr.claimDevice(path) {
		t.Fatal("第一次应该能认领")
	}
	if tr.claimDevice(path) {
		t.Fatal("同一台设备不该重复起")
	}
	tr.releaseDevice(path)
	if !tr.claimDevice(path) {
		t.Fatal("设备交还后应该能重新认领")
	}
	if !tr.notifyOnce(path) || tr.notifyOnce(path) {
		t.Fatal("同一台设备的打开失败只报一次")
	}
}

// 设备表读不到（非 Linux、没权限）时不许 panic，也不许把旧的 hasInput 状态留在那儿。
func TestScanInputDevicesMissingFile(t *testing.T) {
	if _, err := scanInputDevices(filepath.Join(t.TempDir(), "nope")); err == nil {
		t.Fatal("文件不存在应报错")
	}
	tr := newInputTracker(nil)
	tr.scanOnce(t.Context(), filepath.Join(t.TempDir(), "nope"))
	if _, hasInput := tr.Idle(); hasInput {
		t.Fatal("扫不到设备表时 hasInput 应为 false")
	}
}

// 线上契约：adapter 发 presence，hub 回 presence-ok，id 原样回填。
func TestPresenceOverSocket(t *testing.T) {
	sock, s := startTestHub(t)
	clk := newFakeClock(time.Date(2026, 4, 8, 12, 0, 0, 0, time.UTC))
	s.input = newInputTracker(clk.now)
	clk.advance(200 * time.Millisecond)

	adapter := dial(t, sock)
	defer adapter.Close()
	mustSend(t, adapter, Envelope{V: 1, Type: typeHello, Role: roleAdapter})
	if hello := mustRecv(t, adapter); hello.Type != typeHelloOK {
		t.Fatalf("hello-ok %+v", hello)
	}

	mustSend(t, adapter, Envelope{V: 1, Type: typePresence, ID: "presence-1"})
	raw := mustRecvRaw(t, adapter)
	if string(raw["type"]) != `"presence-ok"` || string(raw["id"]) != `"presence-1"` {
		t.Fatalf("presence-ok %v", raw)
	}
	// 两个字段都必须在线：hasInput=false 也要明确出现，缺字段调用方只能拿到 undefined
	if got, ok := raw["hasInput"]; !ok || string(got) != "false" {
		t.Fatalf("hasInput 应是明确的 false：%v", raw)
	}
	if got := string(raw["idleMs"]); got != "200" {
		t.Fatalf("从未有活动时应以 tracker 启动时刻为基准，idleMs=%s", got)
	}

	// 有了键击和可读设备之后：idle 从键击那刻起算，hasInput 翻 true
	s.input.setReading("/dev/input/event4", true)
	clk.advance(3 * time.Second)
	s.input.consume(encodeInputEvent(evKey, 30, 1))
	clk.advance(1500 * time.Millisecond)
	mustSend(t, adapter, Envelope{V: 1, Type: typePresence, ID: "presence-2"})
	raw = mustRecvRaw(t, adapter)
	if string(raw["id"]) != `"presence-2"` {
		t.Fatalf("id 没原样回填：%v", raw)
	}
	if got := string(raw["idleMs"]); got != "1500" {
		t.Fatalf("idleMs=%s want 1500", got)
	}
	if got := string(raw["hasInput"]); got != "true" {
		t.Fatalf("hasInput=%s want true", got)
	}
}

// presence 是给适配器压卡用的，别的角色问不出去。
func TestPresenceRejectsNonAdapter(t *testing.T) {
	sock, _ := startTestHub(t)

	pi := dial(t, sock)
	defer pi.Close()
	mustSend(t, pi, Envelope{V: 1, Type: typeHello, Role: rolePI})
	mustRecv(t, pi)

	mustSend(t, pi, Envelope{V: 1, Type: typePresence, ID: "p"})
	out := mustRecv(t, pi)
	if out.Type != typeError {
		t.Fatalf("pi 问 presence 应被拒：%+v", out)
	}
}

// presence-ok 的两个新字段不能顺手加进别的消息里：旧对端按字段表解析，
// 多出来的字段会让「这条消息是什么」变得含糊。
func TestPresenceFieldsStayOffOtherMessages(t *testing.T) {
	sock, _ := startTestHub(t)

	adapter := dial(t, sock)
	defer adapter.Close()
	mustSend(t, adapter, Envelope{V: 1, Type: typeHello, Role: roleAdapter})
	raw := mustRecvRaw(t, adapter)
	if _, ok := raw["idleMs"]; ok {
		t.Fatalf("hello-ok 不该带 idleMs：%v", raw)
	}
	if _, ok := raw["hasInput"]; ok {
		t.Fatalf("hello-ok 不该带 hasInput：%v", raw)
	}
	var env Envelope
	data, err := json.Marshal(raw)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &env); err != nil {
		t.Fatal(err)
	}
	if env.IdleMs != nil || env.HasInput != nil {
		t.Fatalf("反序列化后也应为 nil：%+v", env)
	}
}
