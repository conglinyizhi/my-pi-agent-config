//go:build darwin

// landlock-run（darwin 版）— macOS Seatbelt 沙箱启动器
//
// 与 Linux 版同一 CLI 契约（--ro/--rw/--probe），机制换成 sandbox-exec（Seatbelt）：
// 构造 SBPL profile 后 exec `sandbox-exec -p <profile> -- <cmd>`。
//
// SBPL 语义（对齐 Linux 版 grants）：
//   (version 1) (allow default) (deny file-write*)      → 默认全允许、禁止一切写
//   (allow file-write* (literal "/dev/null"))            → 允许 /dev/null 写
//   (allow file-write* (subpath <--rw 根>)…)             → 允许 workspace/tmp 等可写根
// 读不受限（default allow），与 Linux 版 --ro / 的全系统只读等效。
//
// 注意：sandbox-exec 被 Apple 标记废弃（Catalina 起）但仍可用（DSH 的
// macOS 沙箱链同样用它）；SBPL 语法参考 DSH dsh-sandbox-local 的
// seatbeltProfileArgs。本文件仅 darwin 构建（Linux 版见 main.go，
// 其余平台见 stub_other.go）。

package main

import (
	"fmt"
	"os"
	"strings"
	"syscall"
)

const exitLauncherFailure = 125

func sbplString(s string) string {
	return `"` + strings.ReplaceAll(strings.ReplaceAll(s, `\`, `\\`), `"`, `\"`) + `"`
}

// 构造 SBPL profile：可写根 = 所有 --rw 参数（--ro 在 Seatbelt 下无意义，默认全读）
func buildProfile(rw []string) string {
	forms := []string{
		"(version 1)",
		"(allow default)",
		"(deny file-write*)",
		`(allow file-write* (literal ` + sbplString("/dev/null") + `))`,
	}
	if len(rw) > 0 {
		subpaths := make([]string, 0, len(rw))
		for _, root := range rw {
			subpaths = append(subpaths, "(subpath "+sbplString(root)+")")
		}
		forms = append(forms, "(allow file-write* "+strings.Join(subpaths, " ")+")")
	}
	return strings.Join(forms, " ")
}

func parseArgs(args []string) (probe bool, rw []string, command []string, errMsg string) {
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--probe":
			if len(args) != 1 {
				return false, nil, nil, "--probe takes no other arguments"
			}
			return true, nil, nil, ""
		case "--ro":
			i++ // Seatbelt 默认全读，--ro 忽略（保留语法兼容）
		case "--rw":
			if i+1 >= len(args) {
				return false, nil, nil, "--rw requires a path"
			}
			i++
			rw = append(rw, args[i])
		case "--":
			command = args[i+1:]
			if len(command) == 0 {
				return false, nil, nil, "missing `-- <argv>...` command"
			}
			return false, rw, command, ""
		default:
			return false, nil, nil, "unknown argument: " + args[i]
		}
	}
	return false, nil, nil, "missing `-- <argv>...` command"
}

// sandbox-exec 固定位于 /usr/bin/sandbox-exec；命令 argv[0]（如 bash）由
// sandbox-exec 内部按 PATH 解析执行。
func execSandbox(argv []string) error {
	return syscall.Exec("/usr/bin/sandbox-exec", argv, os.Environ())
}

func main() {
	probe, rw, command, errMsg := parseArgs(os.Args[1:])
	if errMsg != "" {
		fmt.Fprintf(os.Stderr, "landlock-run: usage error: %s\n", errMsg)
		os.Exit(exitLauncherFailure)
	}

	if probe {
		// 功能性探测：用最小 profile（禁写一切）实际跑 sandbox-exec，
		// 只有真正执行成功才是诚实信号（与 Linux 版 --probe 同理）。
		probeProfile := "(version 1) (allow default) (deny file-write*)"
		argv := []string{"sandbox-exec", "-p", probeProfile, "--", "/usr/bin/true"}
		if err := execSandbox(argv); err != nil {
			fmt.Fprintln(os.Stderr, "landlock: not enforced by this macOS (sandbox-exec unavailable or failed)")
			os.Exit(exitLauncherFailure)
		}
		fmt.Println("landlock: fully enforced (Seatbelt)")
		os.Exit(0)
	}

	profile := buildProfile(rw)
	argv := []string{"sandbox-exec", "-p", profile, "--"}
	argv = append(argv, command...)
	if err := execSandbox(argv); err != nil {
		fmt.Fprintf(os.Stderr, "landlock-run: exec failed: %v\n", err)
		os.Exit(exitLauncherFailure)
	}
}
