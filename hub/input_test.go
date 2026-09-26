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

// 只有 EV_KEY 且 value != 0 算用户活动：EV_REL（鼠标漂移）与 EV_SYN 一律不算。
func TestInputOnlyCountsKeyPress(t *testing.T) {
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
		{"EV_REL 鼠标移动", encodeInputEvent(evRel, 0, 5), false},
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
