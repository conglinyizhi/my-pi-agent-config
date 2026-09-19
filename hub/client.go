package main

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"time"
)

func runClient(socketPath string, args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "用法: pi-hub grant <PIHUB-码>  |  list  |  pairs")
		return 2
	}
	conn, err := net.DialTimeout("unix", socketPath, 2*time.Second)
	if err != nil {
		fmt.Fprintf(os.Stderr, "连不上 hub（%s）：%v\n", socketPath, err)
		return 1
	}
	defer conn.Close()
	enc := json.NewEncoder(conn)
	dec := json.NewDecoder(conn)
	if err := enc.Encode(Envelope{V: protocolVersion, Type: typeHello, Role: roleAdmin}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	var hello Envelope
	if err := dec.Decode(&hello); err != nil || hello.Type != typeHelloOK {
		fmt.Fprintln(os.Stderr, "hello 失败")
		return 1
	}
	switch args[0] {
	case "grant":
		if len(args) < 2 {
			fmt.Fprintln(os.Stderr, "用法: pi-hub grant <PIHUB-码>")
			return 2
		}
		if err := enc.Encode(Envelope{V: protocolVersion, Type: typeGrant, Code: args[1]}); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		var out Envelope
		if err := dec.Decode(&out); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		if out.Type != typeGrantOK {
			fmt.Fprintf(os.Stderr, "%s\n", out.Message)
			if out.Message == "" {
				fmt.Fprintln(os.Stderr, "grant 失败")
			}
			return 1
		}
		name := out.Principal.DisplayName
		if name == "" {
			name = out.Principal.UserID
		}
		fmt.Printf("已授权 %s / %s\n", out.Principal.Channel, name)
		return 0
	case "list":
		if err := enc.Encode(Envelope{V: protocolVersion, Type: typeList}); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		var out Envelope
		if err := dec.Decode(&out); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		if out.Type != typeListOK {
			fmt.Fprintln(os.Stderr, out.Message)
			return 1
		}
		if len(out.Items) == 0 {
			fmt.Println("没有未决审批")
			return 0
		}
		for _, item := range out.Items {
			fmt.Printf("%s  %s  %s  %s\n", item.RequestID, item.Kind, item.ExpiresAt, item.Command)
		}
		return 0
	case "pairs":
		if err := enc.Encode(Envelope{V: protocolVersion, Type: typePairs}); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		var out Envelope
		if err := dec.Decode(&out); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		if out.Type != typePairsOK {
			fmt.Fprintln(os.Stderr, out.Message)
			return 1
		}
		if len(out.Pairs) == 0 {
			fmt.Println("没有待授权账号")
			return 0
		}
		for _, p := range out.Pairs {
			name := p.DisplayName
			if name == "" {
				name = p.UserID
			}
			fmt.Printf("%s  %s/%s  %s\n", p.Code, p.Channel, name, p.ExpiresAt)
		}
		return 0
	default:
		fmt.Fprintf(os.Stderr, "未知子命令 %s（grant / list / pairs）\n", args[0])
		return 2
	}
}
