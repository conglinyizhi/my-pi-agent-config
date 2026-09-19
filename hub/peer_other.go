//go:build !linux

package main

import "net"

func peerUID(conn net.Conn) (uint32, error) {
	return 0, errNotUnix
}
