//go:build !linux && !darwin

// landlock-run 非 Linux 平台 stub：Landlock 是 Linux 内核机制
// （5.13+，无特权文件系统自限），Windows/macOS 上不存在对应 syscall。
// 保证交叉编译（GOOS=windows/darwin go build）能成功产出可执行文件，
// 运行时明确报错而非静默降级——沙箱在非 Linux 平台"不适用"而非"不可用"。

package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr,
		"landlock-run: only supported on Linux (Landlock kernel mechanism, Linux 5.13+)")
	os.Exit(125)
}
