package main

import _ "embed"

// 页面直接嵌进二进制：这个守护只在一个目录里自洽，多带一个 html 文件
// 就多一个「装的时候漏拷」的失败点。
//
//go:embed page.html
var pageHTML []byte

// 管理页分开放：上传页是给手机的，管理页只给主机本机，两边的读者与风险不一样，
// 同一个文件里做二选一反而看不清哪边改了什么。
//
//go:embed manage.html
var manageHTML []byte

// manageArchiveSlot 是 manage.html 里归档目录路径的占位符。路径要 Serving 时
// 才能知道（它跟着 -state 走），而又不想为一行字引 html/template 或者多开一个接口。
var manageArchiveSlot = []byte("{{ARCHIVE}}")
