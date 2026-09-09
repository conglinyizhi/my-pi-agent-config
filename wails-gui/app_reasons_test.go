package main

import (
	"path/filepath"
	"testing"
)

func TestReasonLibraryAddUpdateDeleteLimitAndDeduplicate(t *testing.T) {
	app := &App{reasonsFile: filepath.Join(t.TempDir(), "reasons.csv")}

	if err := app.SaveReason("第一条"); err != nil {
		t.Fatal(err)
	}
	if err := app.SaveReason("第一条"); err != nil {
		t.Fatal(err)
	}
	entries, err := app.LoadReasons()
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Content != "第一条" {
		t.Fatalf("expected one deduplicated entry, got %#v", entries)
	}

	if err := app.UpdateReason("第一条", "更新后的附言"); err != nil {
		t.Fatal(err)
	}
	entries, err = app.LoadReasons()
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Content != "更新后的附言" {
		t.Fatalf("expected updated entry, got %#v", entries)
	}
	if err := app.UpdateReason("不存在的旧内容", "补入列表顶部"); err != nil {
		t.Fatal(err)
	}
	entries, err = app.LoadReasons()
	if err != nil {
		t.Fatal(err)
	}
	if entries[0].Content != "补入列表顶部" {
		t.Fatalf("expected missing old content update at top, got %#v", entries)
	}

	if err := app.DeleteReason("更新后的附言"); err != nil {
		t.Fatal(err)
	}
	entries, err = app.LoadReasons()
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Content != "补入列表顶部" {
		t.Fatalf("expected deleted entry to be absent, got %#v", entries)
	}
	if err := app.UpdateReason("补入列表顶部", "   "); err == nil {
		t.Fatal("expected empty update content to fail")
	}

	for i := 0; i < 25; i++ {
		if err := app.SaveReason(string(rune('a' + i))); err != nil {
			t.Fatal(err)
		}
	}
	entries, err = app.LoadReasons()
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 20 {
		t.Fatalf("expected 20-entry limit, got %d", len(entries))
	}
	if entries[0].Content != string(rune('a'+24)) {
		t.Fatalf("expected newest entry first, got %q", entries[0].Content)
	}
}
