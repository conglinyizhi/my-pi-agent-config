//go:build !linux

package main

import "net"

// 非 Linux 没有 SO_PEERCRED，只能靠 socket 文件权限。主线只跑 Linux，
// 这里留个编译得过的退路，免得 go test ./... 在别的系统上直接挂掉。
func peerUID(conn net.Conn) (uint32, error) {
	return 0, errNotUnix
}
