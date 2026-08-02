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

func main() {
	// CLI: pi-gui <window-name> <request.json> <response.json>
	// （对齐 gui-kit 的 spawn 参数模型）
	args := os.Args[1:]
	windowName := "setup"
	requestFile := ""
	responseFile := ""
	if len(args) >= 3 {
		windowName = args[0]
		requestFile = args[1]
		responseFile = args[2]
	}
	_ = windowName

	app := NewApp(requestFile, responseFile)

	// 窗口配置按 windowName 分支（对齐 app.ts 的 createGuiApp 配置）
	title := "三叉戟 · 模型路由配置"
	width := 960
	height := 600

	err := wails.Run(&options.App{
		Title:  title,
		Width:  width,
		Height: height,
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
