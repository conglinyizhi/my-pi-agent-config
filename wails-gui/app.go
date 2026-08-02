package main

import (
	"encoding/json"
	"os"
)

// App 是对应 gui-kit.mjs 的 Go 侧实现：
//   createGuiApp(inject)   -> NewApp(windowName) + GetInitData()
//   fs.writeFileSync       -> SaveResponse()
//   .ready sidecar         -> MarkReady()
type App struct {
	windowName   string
	requestFile  string
	responseFile string
}

func NewApp(windowName, requestFile, responseFile string) *App {
	return &App{windowName: windowName, requestFile: requestFile, responseFile: responseFile}
}

// GetWindowName 前端路由壳按名字选视图
func (a *App) GetWindowName() string {
	return a.windowName
}

// readRequest 读取 request 文件（失败写 .error sidecar）
func (a *App) readRequest() (map[string]interface{}, error) {
	data, err := os.ReadFile(a.requestFile)
	if err != nil {
		a.writeError(err.Error())
		return nil, err
	}
	var req map[string]interface{}
	if err := json.Unmarshal(data, &req); err != nil {
		a.writeError(err.Error())
		return nil, err
	}
	return req, nil
}

// GetInitData 按窗口分支注入数据（对齐各 app.ts 的 inject 输出结构）
func (a *App) GetInitData() (map[string]interface{}, error) {
	req, err := a.readRequest()
	if err != nil {
		return map[string]interface{}{}, err
	}
	base := map[string]interface{}{"responseFile": a.responseFile}
	switch a.windowName {
	case "setup":
		base["models"] = req["models"]
		base["roles"] = req["roles"]
	case "review":
		base["texts"] = req["texts"]
	case "manager":
		base["tasks"] = req["tasks"]
	case "routing":
		base["todos"] = req["todos"]
	case "gate":
		base["command"] = req["command"]
		base["taskId"] = req["taskId"]
		base["rules"] = req["rules"]
	case "editor":
		base["clipHistory"] = req["clipHistory"]
	}
	return base, nil
}

// SaveResponse 写响应文件（对齐 fs.writeFileSync(responseFile, JSON.stringify(payload))）
func (a *App) SaveResponse(payload string) error {
	return os.WriteFile(a.responseFile, []byte(payload), 0644)
}

// MarkReady 前端 Vue 挂载完成后调用，写 .ready sidecar（对齐 gui-kit 的 ready 轮询）
func (a *App) MarkReady() {
	_ = os.WriteFile(a.responseFile+".ready", []byte("ok"), 0644)
}

func (a *App) writeError(msg string) {
	_ = os.WriteFile(a.responseFile+".error", []byte(msg), 0644)
}
