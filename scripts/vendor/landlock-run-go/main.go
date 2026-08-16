//go:build linux

// landlock-run — Go 版 Landlock 沙箱启动器（self-restrict-then-exec）
//
// 语义逐行对照 deepseek-harness 的 C 版
// （native/landlock-run/packages/entry/src/main.c），CLI 契约完全一致：
//
//   landlock-run [--ro <path>]... [--rw <path>]... -- <argv>...
//   landlock-run --probe
//
// --ro 授读+执行；--rw 授完整文件系统访问；未授权一律拒绝（allow-list）。
// 流程：ABI 协商 → 建规则集 → 加 path-beneath 规则 → no_new_privs →
// landlock_restrict_self（限当前进程）→ exec 目标命令（规则跨 execve 继承）。
// fail-closed：内核不支持/规则建不了 → exit 125 且不 exec。
//
// 构建（静态）：
//   CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o ../landlock-run .
//
// 与 C 版的差异仅实现语言；x/sys/unix 无现成 Landlock 封装，直接用
// unix.Syscall 调裸 syscall（号 444/445/446），与 C 版手写 UAPI 同理。

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/unix"
)

const (
	landlockCreateRulesetVersion = 0x1 // LANDLOCK_CREATE_RULESET_VERSION
	landlockRulePathBeneath      = 0x1 // LANDLOCK_RULE_PATH_BENEATH
	exitLauncherFailure          = 125
	maxABI                       = int64(5) // 本实现知道的最新 ABI（C 版一致）
)

// Landlock 文件系统访问位（按引入的 ABI 分组）
const (
	fsExecute    = uint64(1) << 0  // ABI 1
	fsWriteFile  = uint64(1) << 1
	fsReadFile   = uint64(1) << 2
	fsReadDir    = uint64(1) << 3
	fsRemoveDir  = uint64(1) << 4
	fsRemoveFile = uint64(1) << 5
	fsMakeChar   = uint64(1) << 6
	fsMakeDir    = uint64(1) << 7
	fsMakeReg    = uint64(1) << 8
	fsMakeSock   = uint64(1) << 9
	fsMakeFifo   = uint64(1) << 10
	fsMakeBlock  = uint64(1) << 11
	fsMakeSym    = uint64(1) << 12
	fsRefer      = uint64(1) << 13 // ABI 2
	fsTruncate   = uint64(1) << 14 // ABI 3
	fsIoctlDev   = uint64(1) << 15 // ABI 5

	fsABI1Mask = fsRefer - 1 // 位 0..12：全部 ABI-1 访问，不含更新的
)

// 一个 ABI 版本能管辖的文件系统访问位
func fsMaskForABI(abi int64) uint64 {
	mask := fsABI1Mask
	if abi >= 2 {
		mask |= fsRefer
	}
	if abi >= 3 {
		mask |= fsTruncate
	}
	if abi >= 5 {
		mask |= fsIoctlDev
	}
	return mask
}

// ── 裸 syscall 封装（x/sys/unix 无现成 Landlock 函数） ──

// 协商内核 Landlock ABI 版本（create_ruleset(NULL, 0, VERSION)）
func landlockABIVersion() (int64, error) {
	r0, _, errno := unix.Syscall(unix.SYS_LANDLOCK_CREATE_RULESET, 0, 0, landlockCreateRulesetVersion)
	if errno != 0 {
		return 0, errno
	}
	return int64(r0), nil
}

func landlockCreateRuleset(attr *unix.LandlockRulesetAttr) (int, error) {
	r0, _, errno := unix.Syscall(unix.SYS_LANDLOCK_CREATE_RULESET,
		uintptr(unsafe.Pointer(attr)), unsafe.Sizeof(*attr), 0)
	if errno != 0 {
		return 0, errno // syscall.Errno(0) 是非 nil error，成功路径显式返回 nil
	}
	return int(r0), nil
}

func landlockAddRule(fd int, attr *unix.LandlockPathBeneathAttr) error {
	// add_rule(ruleset_fd, rule_type, rule_attr, flags) — 4 个参数，用 Syscall6
	_, _, errno := unix.Syscall6(unix.SYS_LANDLOCK_ADD_RULE,
		uintptr(fd), landlockRulePathBeneath, uintptr(unsafe.Pointer(attr)), 0, 0, 0)
	if errno != 0 {
		return errno
	}
	return nil
}

func landlockRestrictSelf(fd int) error {
	_, _, errno := unix.Syscall(unix.SYS_LANDLOCK_RESTRICT_SELF, uintptr(fd), 0, 0)
	if errno != 0 {
		return errno
	}
	return nil
}

// ── 输出与退出 ──

func fail(msg string, detail error) int {
	if detail != nil {
		fmt.Fprintf(os.Stderr, "landlock-run: %s: %v\n", msg, detail)
	} else {
		fmt.Fprintf(os.Stderr, "landlock-run: %s\n", msg)
	}
	return exitLauncherFailure
}

func failUsage(msg, arg string) int {
	if arg != "" {
		fmt.Fprintf(os.Stderr, "landlock-run: usage error: %s: %s\n", msg, arg)
	} else {
		fmt.Fprintf(os.Stderr, "landlock-run: usage error: %s\n", msg)
	}
	return exitLauncherFailure
}

// ── CLI 解析 ──

type cli struct {
	probe   bool
	ro      []string
	rw      []string
	command []string
}

func parse(args []string) (*cli, int) {
	c := &cli{}
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--probe":
			if len(args) != 1 {
				return nil, failUsage("--probe takes no other arguments", "")
			}
			c.probe = true
		case "--ro", "--rw":
			if i+1 >= len(args) {
				return nil, failUsage(args[i], "requires a path")
			}
			if args[i] == "--ro" {
				c.ro = append(c.ro, args[i+1])
			} else {
				c.rw = append(c.rw, args[i+1])
			}
			i++
		case "--":
			c.command = args[i+1:]
			if len(c.command) == 0 {
				return nil, failUsage("missing `-- <argv>...` command", "")
			}
			return c, 0
		default:
			return nil, failUsage("unknown argument:", args[i])
		}
	}
	if !c.probe {
		return nil, failUsage("missing `-- <argv>...` command", "")
	}
	return c, 0
}

// ── 规则 ──

// 添加一条 path-beneath 规则；fail-closed：授权根打不开就拒绝（不静默收窄）
func addRule(rulesetFD int, path string, access uint64) int {
	pathFD, err := unix.Open(path, unix.O_PATH|unix.O_CLOEXEC, 0)
	if err != nil {
		return fail("cannot open rule path: "+path, err)
	}
	// 非目录规则只保留文件兼容位（内核拒绝目录位用于文件，EINVAL）
	var st unix.Stat_t
	if unix.Fstat(pathFD, &st) == nil && st.Mode&unix.S_IFMT != unix.S_IFDIR {
		access &= fsExecute | fsWriteFile | fsReadFile | fsTruncate | fsIoctlDev
	}
	attr := unix.LandlockPathBeneathAttr{Allowed_access: access, Parent_fd: int32(pathFD)}
	if err := landlockAddRule(rulesetFD, &attr); err != nil {
		unix.Close(pathFD)
		return fail("landlock ruleset error", err)
	}
	unix.Close(pathFD)
	return 0
}

// 在当前进程上装规则集：ABI 协商 → 规则 → no_new_privs → restrict_self
func restrictSelf(c *cli) (int, bool) {
	abi, err := landlockABIVersion()
	if err != nil {
		// ENOSYS：内核无 Landlock；EOPNOTSUPP：编译了但被禁用。均不可强制 → fail-closed
		return fail("landlock is not enforced by this kernel (ABI unsupported or disabled)", nil), false
	}
	partial := abi < maxABI
	effectiveABI := abi
	if effectiveABI > maxABI {
		effectiveABI = maxABI
	}
	handled := fsMaskForABI(effectiveABI)

	attr := unix.LandlockRulesetAttr{Access_fs: handled}
	rulesetFD, err := landlockCreateRuleset(&attr)
	if err != nil {
		return fail("landlock ruleset error", err), false
	}

	readSide := fsExecute | fsReadFile | fsReadDir
	for _, p := range c.ro {
		if code := addRule(rulesetFD, p, readSide&handled); code != 0 {
			return code, false
		}
	}
	for _, p := range c.rw {
		if code := addRule(rulesetFD, p, handled); code != 0 {
			return code, false
		}
	}

	if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
		return fail("landlock ruleset error", err), false
	}
	if err := landlockRestrictSelf(rulesetFD); err != nil {
		return fail("landlock ruleset error", err), false
	}
	unix.Close(rulesetFD)
	return 0, partial
}

func main() {
	c, code := parse(os.Args[1:])
	if code != 0 {
		os.Exit(code)
	}

	if c.probe {
		// 功能性探测：在本进程实际 restrict 一个最大规则集（只读 /），
		// 只有真正执行成功才是诚实信号。报告行是 CLI 契约的一部分。
		probe := &cli{ro: []string{"/"}}
		code, partial := restrictSelf(probe)
		if code != 0 {
			os.Exit(code)
		}
		if partial {
			fmt.Println("landlock: partially enforced (older ABI)")
		} else {
			fmt.Println("landlock: fully enforced")
		}
		os.Exit(0)
	}

	code, partial := restrictSelf(c)
	if code != 0 {
		os.Exit(code)
	}
	if partial {
		// 旧 ABI：部分访问不被管辖（如 ABI 3 前的 truncate）。仍受限于
		// 内核支持的一切——报告，不拒绝。
		fmt.Fprintln(os.Stderr, "landlock-run: partial enforcement (older Landlock ABI)")
	}

	// execvp 语义：裸 execve 不查 PATH，需手动按 PATH 解析（C 版用 execvp）
	bin := c.command[0]
	if !strings.ContainsRune(bin, '/') {
		for _, dir := range filepath.SplitList(os.Getenv("PATH")) {
			candidate := filepath.Join(dir, bin)
			if unix.Access(candidate, unix.X_OK) == nil {
				bin = candidate
				break
			}
		}
	}
	if err := unix.Exec(bin, c.command, os.Environ()); err != nil {
		os.Exit(fail("exec failed", err))
	}
}
