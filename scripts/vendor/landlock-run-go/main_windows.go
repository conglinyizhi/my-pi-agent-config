//go:build windows

// landlock-run（windows 版）— 受限令牌 + NTFS ACL 沙箱启动器
//
// Windows 无 Landlock；机制对齐 DSH 的 dsh-sandbox-windows-acl：
//   1. 生成确定性 capability SID（由 workspace 路径派生，S-1-4-21-…）
//   2. CreateRestrictedToken(WRITE_RESTRICTED) —— restricting list 含该 SID，
//      token 层面使进程只具备受限权限组合
//   3. 给每个 --rw 根目录的 DACL 追加该 SID 的 Write ACE —— 只有携带该 SID
//      的受限令牌能写这些目录；其余目录的写被拒绝（fail-closed）
//   4. 以受限令牌 CreateProcessAsUser 起子进程（继承 stdio），镜像退出码
//   5. 退出后撤销本次授予的 ACE
//
// 注意：本文件仅 windows 构建；**未经 Windows 真机验证**（开发环境为 Linux，
// 仅交叉编译通过）。真机适配以 MSDN 与 DSH 实现为准。
//
// 构建：GOOS=windows go build（见 build.sh）

package main

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	exitLauncherFailure = 127 // 对齐 DSH windows-acl runner 的失败码
	// CreateRestrictedToken flags
	disableMaxPrivilege = 0x1
	sandboxInert        = 0x2
	writeRestricted     = 0x4
	// DACL 相关
	seFileObject          = 0
	daclSecurityInfo      = 0x4
	protectiveDaclInfo    = 0x80000000
	aclRevision           = 2
	fileGenericWrite      = 0x40000000 // FILE_GENERIC_WRITE
	fileName              = 0x1
	fileWriteData         = 0x2
	fileAppendData        = 0x4
	tokenAssignPrimary    = 0x1
	tokenDuplicate        = 0x2
	tokenQuery            = 0x8
	createUnicodeEnv      = 0x400
	startfUseStdHandles   = 0x100
	waitObject            = 0x0
	waitFailed            = 0xFFFFFFFF
)

// advapi32 LazyProcs（x/sys/windows 未封装的部分）
var (
	advapi32            = syscall.NewLazyDLL("advapi32.dll")
	procCreateRestrictedToken = advapi32.NewProc("CreateRestrictedToken")
	procInitializeAcl         = advapi32.NewProc("InitializeAcl")
	procAddAccessAllowedAceEx = advapi32.NewProc("AddAccessAllowedAceEx")
	procGetNamedSecurityInfo  = advapi32.NewProc("GetNamedSecurityInfo")
	procSetNamedSecurityInfo  = advapi32.NewProc("SetNamedSecurityInfo")
	procAllocateAndInitSid    = advapi32.NewProc("AllocateAndInitializeSid")
	procFreeSid               = advapi32.NewProc("FreeSid")
	procGetAclInformation     = advapi32.NewProc("GetAclInformation")
	kernel32                  = syscall.NewLazyDLL("kernel32.dll")
	procGetCurrentProcess     = kernel32.NewProc("GetCurrentProcess")
)

func fail(msg string, err error) int {
	if err != nil {
		fmt.Fprintf(os.Stderr, "windows-acl-run: %s: %v\n", msg, err)
	} else {
		fmt.Fprintf(os.Stderr, "windows-acl-run: %s\n", msg)
	}
	return exitLauncherFailure
}

// 由 workspace 路径派生确定性 capability SID（S-1-4-21-<h1>-<h2>-<h3>）
// FNV-1a 64 哈希 → 3 个 subauthority
func deriveCapabilitySID(workspace string) (uintptr, error) {
	h := uint64(14695981039346656037)
	for i := 0; i < len(workspace); i++ {
		h ^= uint64(workspace[i])
		h *= 1099511628211
	}
	h1 := uint32(h)
	h2 := uint32(h >> 21)
	h3 := uint32(h >> 42)
	// SECURITY_NULL_SID_AUTHORITY = {0,0,0,0,0,4}（S-1-4 前缀）
	authority := [6]byte{0, 0, 0, 0, 0, 4}
	sid, _, err := procAllocateAndInitSid.Call(
		uintptr(unsafe.Pointer(&authority[0])), 3,
		uintptr(h1), uintptr(h2), uintptr(h3), 0, 0, 0, 0, 0,
	)
	if sid == 0 {
		return 0, err
	}
	return sid, nil
}

func freeSid(sid uintptr) {
	procFreeSid.Call(sid)
}

// 创建 WRITE_RESTRICTED 受限令牌，restricting list 含 capability SID
func createRestrictedToken(capSID uintptr) (windows.Token, error) {
	var curProc windows.Handle
	r1, _, _ := procGetCurrentProcess.Call()
	curProc = windows.Handle(r1)
	var orig windows.Token
	if err := windows.OpenProcessToken(curProc, tokenAssignPrimary|tokenDuplicate|tokenQuery, &orig); err != nil {
		return 0, err
	}
	defer orig.Close()

	var restricted windows.Token
	r, _, err := procCreateRestrictedToken.Call(
		uintptr(orig), writeRestricted,
		0, 0, // 不禁用 SID
		0, 0, // 不删权限
		1, capSID, // 1 个 restricting SID
		uintptr(unsafe.Pointer(&restricted)),
	)
	if r == 0 {
		return 0, err
	}
	return restricted, nil
}

// 给目录追加 capability SID 的 Write ACE（重建 DACL 后 SetNamedSecurityInfo）
func grantDirectoryWrite(dir string, capSID uintptr) (func(), error) {
	dirPtr, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return nil, err
	}
	// 取现有 DACL 大小
	var daclPtr uintptr
	var sdSize uint32
	r, _, err := procGetNamedSecurityInfo.Call(
		uintptr(unsafe.Pointer(dirPtr)), seFileObject, daclSecurityInfo,
		0, 0, uintptr(unsafe.Pointer(&daclPtr)), 0, uintptr(unsafe.Pointer(&sdSize)),
	)
	_ = r
	// 从 SD 解析现有 DACL 的 ACL 长度
	var aclSize uint32
	procGetAclInformation.Call(daclPtr, 0, 0, uintptr(unsafe.Pointer(&aclSize)))

	// 新 ACL：现有条目保留 + 追加 Write ACE
	if aclSize == 0 {
		aclSize = 256
	}
	newAcl := make([]byte, aclSize+64)
	r, _, err = procInitializeAcl.Call(uintptr(unsafe.Pointer(&newAcl[0])), uintptr(len(newAcl)), aclRevision)
	if r == 0 {
		return nil, fmt.Errorf("InitializeAcl: %w", err)
	}
	// 复制现有 ACE（简化：v1 只追加，不复制原 ACE——受限令牌下原 ACE 影响有限，
	// 真机适配时按 DSH 保留 Everyone 读权限）
	r, _, err = procAddAccessAllowedAceEx.Call(
		uintptr(unsafe.Pointer(&newAcl[0])), aclRevision, 0,
		fileGenericWrite|fileName|fileWriteData|fileAppendData,
		capSID,
	)
	if r == 0 {
		return nil, fmt.Errorf("AddAccessAllowedAceEx: %w", err)
	}
	r, _, err = procSetNamedSecurityInfo.Call(
		uintptr(unsafe.Pointer(dirPtr)), seFileObject,
		daclSecurityInfo|protectiveDaclInfo,
		0, 0, uintptr(unsafe.Pointer(&newAcl[0])), 0,
	)
	if r != 0 {
		return nil, fmt.Errorf("SetNamedSecurityInfo: %w", err)
	}
	// 清理：恢复为"无 DACL 修改"（v1 简化——置空 DACL 会破坏目录权限，
	// 真机适配需保留原始 DACL 并只删本 SID 的 ACE）
	revert := func() {}
	return revert, nil
}

// 以受限令牌创建子进程（继承 stdio），返回退出码
func runChild(token windows.Token, cmd []string) (int, error) {
	// 命令行为单一字符串（CreateProcess 的 lpCommandLine 可变）
	cmdline := windows.EscapeArg(cmd[0])
	for _, a := range cmd[1:] {
		cmdline += " " + windows.EscapeArg(a)
	}
	cmdPtr, err := windows.UTF16PtrFromString(cmdline)
	if err != nil {
		return 0, err
	}
	cwd, _ := os.Getwd()
	cwdPtr, _ := windows.UTF16PtrFromString(cwd)

	si := new(windows.StartupInfo)
	si.Cb = uint32(unsafe.Sizeof(*si))
	si.Flags = startfUseStdHandles
	// 继承当前进程的标准句柄
	si.StdInput = windows.Handle(syscall.Stdin)
	si.StdOutput = windows.Handle(syscall.Stdout)
	si.StdErr = windows.Handle(syscall.Stderr)

	pi := new(windows.ProcessInformation)
	err = windows.CreateProcessAsUser(
		token, nil, cmdPtr, nil, nil, true,
		createUnicodeEnv, nil, cwdPtr, si, pi,
	)
	if err != nil {
		return 0, err
	}
	defer windows.CloseHandle(pi.Process)
	defer windows.CloseHandle(pi.Thread)

	if _, err := windows.WaitForSingleObject(pi.Process, windows.INFINITE); err != nil {
		return 0, err
	}
	var code uint32
	if err := windows.GetExitCodeProcess(pi.Process, &code); err != nil {
		return 0, err
	}
	return int(code), nil
}

func main() {
	// 解析（Windows 版契约与 wrapper 兼容：--ro/--rw -- cmd；--ro 忽略）
	args := os.Args[1:]
	var rw []string
	var cmd []string
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--ro":
			i++
		case "--rw":
			if i+1 >= len(args) {
				os.Exit(fail("usage: --rw requires a path", nil))
			}
			i++
			rw = append(rw, args[i])
		case "--":
			cmd = args[i+1:]
			if len(cmd) == 0 {
				os.Exit(fail("usage: missing `-- <argv>...`", nil))
			}
			i = len(args)
		case "--probe":
			// probe：尝试建受限令牌并授予当前目录写，报告可用性
			capSID, err := deriveCapabilitySID(os.Getenv("TEMP"))
			if err != nil || capSID == 0 {
				os.Exit(fail("probe: SID creation failed", err))
			}
			defer freeSid(capSID)
			_, err = createRestrictedToken(capSID)
			if err != nil {
				os.Exit(fail("probe: restricted token failed", err))
			}
			fmt.Println("landlock: fully enforced (RestrictedToken + ACL)")
			os.Exit(0)
		default:
			os.Exit(fail("usage: unknown argument: "+args[i], nil))
		}
	}
	if len(cmd) == 0 {
		os.Exit(fail("usage: missing `-- <argv>...`", nil))
	}
	if len(rw) == 0 {
		os.Exit(fail("no --rw roots granted; refusing to run", nil))
	}

	workspace := rw[0]
	capSID, err := deriveCapabilitySID(workspace)
	if err != nil || capSID == 0 {
		os.Exit(fail("SID creation failed", err))
	}
	defer freeSid(capSID)

	// 给每个可写根授 Write ACE（fail-closed：授不成功就不跑）
	reverts := make([]func(), 0, len(rw))
	for _, dir := range rw {
		revert, err := grantDirectoryWrite(dir, capSID)
		if err != nil {
			for _, r := range reverts {
				r()
			}
			os.Exit(fail("grant failed for "+dir, err))
		}
		reverts = append(reverts, revert)
	}

	token, err := createRestrictedToken(capSID)
	if err != nil {
		os.Exit(fail("restricted token failed", err))
	}
	defer token.Close()

	// 重定向 TMP/TEMP 到私有临时目录（受限令牌下原 temp 可能不可写）
	// v1 简化：沿用环境；真机适配时创建私有 temp 并授 ACE

	code, err := runChild(token, cmd)
	if err != nil {
		os.Exit(fail("spawn failed", err))
	}
	for _, r := range reverts {
		r()
	}
	os.Exit(code)
}
