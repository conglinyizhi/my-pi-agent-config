package main

import (
	"embed"
	"os"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist
var assets embed.FS

// windowConfig 对应 gui-kit 各 app.ts 的 createGuiApp 配置
type windowConfig struct {
	title  string
	width  int
	height int
}

var windowConfigs = map[string]windowConfig{
	"editor":    {"提示词输入 · pi", 800, 450},
	"gate":      {"权限闸门 · 危险命令审计", 800, 520},
	"setup":     {"三叉戟 · 模型路由配置", 960, 600},
	"subagents": {"Subagent 详情 · 三叉戟", 900, 640},
	"routing":   {"TODO 调度 · 三叉戟", 900, 640},
}

func main() {
	// CLI: pi-gui <window-name> <request.json> <response.json>
	args := os.Args[1:]
	windowName := "setup"
	requestFile := ""
	responseFile := ""
	if len(args) >= 3 {
		windowName = args[0]
		requestFile = args[1]
		responseFile = args[2]
	}

	cfg, ok := windowConfigs[windowName]
	if !ok {
		println("unknown window:", windowName)
		os.Exit(1)
	}

	app := NewApp(windowName, requestFile, responseFile)

	err := wails.Run(&options.App{
		Title:  cfg.title,
		Width:  cfg.width,
		Height: cfg.height,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		Bind: []interface{}{
			app,
		},
	})
	if err != nil {
		println("Error:", err.Error())
	}
}
