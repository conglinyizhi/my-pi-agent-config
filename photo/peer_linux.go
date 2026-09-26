//go:build linux

package main

import (
	"net"
	"syscall"
)

// peerUID 拿连接对端的 uid。除了 0600 之外再加一道同 uid 校验：
// socket 权限管的是「谁能打开」，进程换了 uid（比如 sudo 起的 pi）之后
// 权限检查已经过去，只剩这一层能挡住。
func peerUID(conn net.Conn) (uint32, error) {
	uc, ok := conn.(*net.UnixConn)
	if !ok {
		return 0, errNotUnix
	}
	raw, err := uc.SyscallConn()
	if err != nil {
		return 0, err
	}
	var uid uint32
	var sysErr error
	if err := raw.Control(func(fd uintptr) {
		cred, e := syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
		if e != nil {
			sysErr = e
			return
		}
		uid = cred.Uid
	}); err != nil {
		return 0, err
	}
	if sysErr != nil {
		return 0, sysErr
	}
	return uid, nil
}
