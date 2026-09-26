package main

import _ "embed"

// 页面直接嵌进二进制：这个守护只在一个目录里自洽，多带一个 html 文件
// 就多一个「装的时候漏拷」的失败点。
//
//go:embed page.html
var pageHTML []byte
