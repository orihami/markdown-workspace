#Requires AutoHotkey v2.0
#SingleInstance Force
; どこからでも1秒メモ: ko-pi の Markdown Workspace の「めも」に残す
;   Ctrl+Alt+(物理的な M の位置) … メモ窓を出す(memo-quick.ini の hotkey= で変えられる)
;   Ctrl+Enter … めも に残す(名前は書き出しから。date 付き)
;   Esc        … 閉じる(書いた分は窓に残る)
; 送り先は同じフォルダの memo-quick.ini に書く(リポジトリには入れない):
;   [memo]
;   server=https://ko-pi.<tailnet>.ts.net:8443
;   hotkey=^!sc032
; hotkey は AutoHotkey の書き方。^=Ctrl !=Alt +=Shift #=Win。キー配列を変えていても位置で決まるよう、
; 文字ではなくスキャンコード(sc032 = 物理的な M の位置、sc039 = スペース など)を使う。例: ^!sc039、#+sc032、^!F12
; Windows を起動したら動くようにするには、このファイルのショートカットを shell:startup に置く

iniPath := A_ScriptDir "\memo-quick.ini"
server := RTrim(IniRead(iniPath, "memo", "server", ""), "/")
memoKey := Trim(IniRead(iniPath, "memo", "hotkey", "^!sc032"))

memoGui := Gui("+AlwaysOnTop -MinimizeBox", "memo")
memoGui.SetFont("s11", "Yu Gothic UI")
memoGui.MarginX := 12
memoGui.MarginY := 10
memoEdit := memoGui.AddEdit("w480 r7 WantReturn")
memoTask := memoGui.AddCheckbox("xm y+8", "今日のタスクにする")
memoStatus := memoGui.AddText("x+16 yp w260 cGray", "Ctrl+Enter で残す")
memoGui.OnEvent("Escape", (*) => memoGui.Hide())
memoGui.OnEvent("Close", (*) => memoGui.Hide())

ShowMemo(*) {
    memoStatus.Text := "Ctrl+Enter で残す"
    memoGui.Show("AutoSize")
    memoEdit.Focus()
}
try
    Hotkey(memoKey, ShowMemo)
catch
    MsgBox("memo-quick.ini の hotkey=" memoKey " が使えません。書き方を確かめてください", "memo")

; 残す: Ctrl+Enter(Enter は位置が変わりにくいので sc01C で決める)
#HotIf WinActive("ahk_id " memoGui.Hwnd)
^sc01C:: SendMemo()
#HotIf

SendMemo() {
    text := Trim(memoEdit.Value, " `t`r`n")
    if (text = "")
        return
    if (server = "") {
        MsgBox("memo-quick.ini に送り先(server=)を書いてください", "memo")
        return
    }
    body := '{"text":' JsonStr(text) ',"task":' (memoTask.Value ? "true" : "false") '}'
    memoStatus.Text := "送っています…"
    try {
        req := ComObject("WinHttp.WinHttpRequest.5.1")
        req.Open("POST", server "/api/capture", false)
        req.SetRequestHeader("Content-Type", "application/json; charset=utf-8")
        req.SetTimeouts(5000, 5000, 10000, 10000)
        req.Send(Utf8(body))
        if (req.Status = 200) {
            memoEdit.Value := ""
            memoTask.Value := 0
            memoStatus.Text := "残しました"
            SetTimer(() => memoGui.Hide(), -700)
        } else
            memoStatus.Text := "残せませんでした(" req.Status ")。書いた分は残っています"
    } catch {
        memoStatus.Text := "つながりません。書いた分は残っています"
    }
}

; JSON の文字列にする(\ " 改行 タブ をエスケープ)
JsonStr(s) {
    s := StrReplace(s, "\", "\\")
    s := StrReplace(s, '"', '\"')
    s := StrReplace(s, "`r`n", "\n")
    s := StrReplace(s, "`n", "\n")
    s := StrReplace(s, "`r", "\n")
    s := StrReplace(s, "`t", "\t")
    return '"' s '"'
}

; UTF-8 のバイト列にして送る(WinHttp に文字列のまま渡すと日本語が化けることがあるため)
Utf8(s) {
    n := StrPut(s, "UTF-8") - 1
    buf := Buffer(n + 1)
    StrPut(s, buf, "UTF-8")
    arr := ComObjArray(0x11, n)
    loop n
        arr[A_Index - 1] := NumGet(buf, A_Index - 1, "UChar")
    return arr
}
