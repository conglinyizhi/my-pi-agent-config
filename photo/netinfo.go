package main

import (
	"net"
)

// lanURL 把监听地址换成手机能打开的地址。默认监听 0.0.0.0，而 0.0.0.0 对手机
// 毫无意义，得另找一个本机真实存在的地址；一个都找不到就用 127.0.0.1，
// 本机还能用，好过给一个连不上的假地址。
//
// 这里不拼 token：这行会进 journal，口令不该跟着进去。
func lanURL(addr string) string {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return "127.0.0.1"
	}
	if ip := net.ParseIP(host); ip == nil || ip.IsUnspecified() {
		if lan := lanIPv4(); lan != "" {
			host = lan
		} else {
			host = "127.0.0.1"
		}
	}
	return net.JoinHostPort(host, port)
}

// lanIPv4 挑一个非回环的 IPv4，私有网段优先。
// 不按网卡名或 wifi/有线去猜：本机可能有 docker0、tun0 一堆地址，
// 猜错时用户自己换一个就行；这里只保证给出来的是本机真实存在的地址。
func lanIPv4() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	fallback := ""
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := ifc.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ipnet, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip4 := ipnet.IP.To4()
			if ip4 == nil || ip4.IsLoopback() || ip4.IsLinkLocalUnicast() {
				continue
			}
			if ip4.IsPrivate() {
				return ip4.String()
			}
			if fallback == "" {
				fallback = ip4.String()
			}
		}
	}
	return fallback
}
