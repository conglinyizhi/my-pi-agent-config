package main

import (
	"net"
)

// webURL 拼出手机该打开的那个地址。监听地址是 0.0.0.0（默认）时，
// 0.0.0.0 对手机毫无意义，得另找一个本机真实存在的地址；
// 一个都找不到就回 127.0.0.1，本机还能用，也好过给一个连不上的假地址。
func (s *Server) webURL() string {
	host, port, err := net.SplitHostPort(s.webAddr)
	if err != nil {
		return "http://127.0.0.1/?k=" + s.st.Token()
	}
	if ip := net.ParseIP(host); ip == nil || ip.IsUnspecified() {
		if lan := lanIPv4(); lan != "" {
			host = lan
		} else {
			host = "127.0.0.1"
		}
	}
	return "http://" + net.JoinHostPort(host, port) + "/?k=" + s.st.Token()
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
