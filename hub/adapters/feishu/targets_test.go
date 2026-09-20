package main

import "testing"

func TestPushTargetsUsesPrincipals(t *testing.T) {
	a := &adapter{chats: map[string]string{"ou_1": "oc_1"}, cards: map[string]askTarget{}}
	got := a.pushTargets([]principal{
		{Channel: "feishu", UserID: "ou_1"},
		{Channel: "feishu", UserID: "ou_2"},
		{Channel: "别的通道", UserID: "u9"},
		{Channel: "feishu", UserID: "ou_1"},
		{Channel: "feishu", UserID: ""},
	})
	if len(got) != 2 {
		t.Fatalf("只该留本通道的两个账号：%+v", got)
	}
	if got[0].UserID != "ou_1" || got[0].ChatID != "oc_1" {
		t.Fatalf("已知 chat 没用上：%+v", got[0])
	}
	if got[1].UserID != "ou_2" || got[1].ChatID != "" {
		t.Fatalf("不知道 chat 时该按 open_id 直发：%+v", got[1])
	}
}

func TestPushTargetsEmptyWithoutPrincipals(t *testing.T) {
	a := &adapter{chats: map[string]string{"ou_1": "oc_1"}}
	if got := a.pushTargets(nil); len(got) != 0 {
		t.Fatalf("没有授权名单时不该推给谁——跟 bot 说过话不等于已授权：%+v", got)
	}
}
