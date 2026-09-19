//go:build linux

package main

import (
	"net"
	"syscall"
)

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
