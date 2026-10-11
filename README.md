# Claude セッションの状態

Claude Code のセッションを3つ、4つと同時に動かしたときに、どれが作業中で、どれの答えが出たかを、VS Code の画面の一番下（ステータスバー）に色付きで並べる拡張です。

Claude Code の拡張は、タブの色や印をほかから変えられないため、タブの代わりに画面下に出します。

> **非公式の拡張です。** Anthropic とは関係ありません。
> Claude Code が手元に書き出している内部のファイルを読んで動くため、Claude Code の更新で動かなくなることがあります。

## 1. 表示（色の決まり4つ）

| 印 | 意味 |
|---|---|
| 🟢 | 作業中 |
| 🔵 | 入力待ち（許可や質問の答えを待っている） |
| 🟤 | 答えが出た（まだそのタブを見ていない） |
| ⚪ 数 | 待機中のセッションの数（名前はマウスを乗せると出る） |

名前の付いた印を押すと、そのセッションのタブに移ります。
茶色は、そのタブを開いたときか、印を押したときに消えます。

## 2. 仕組み（読むファイル2つ）

- `~/.claude/sessions/<pid>.json` … Claude Code が書く、セッションごとの状態の記録（`busy`・`waiting`・`idle`）
- `~/.claude/projects/*/<sessionId>.jsonl` の末尾 … タブに出ている名前（`custom-title`、無ければ `ai-title`）

書き込みはしません。Claude Code の設定とフックには触れず、外への通信もしません。

## 3. 入れ方と直し方（3手）

```
python build_vsix.py
```

```
code --install-extension dist\claude-session-status-0.0.1.vsix --force
```

最後に VS Code で「Developer: Reload Window（ウィンドウの再読み込み）」を1回行います。
直したときは package.json の version を上げてから、同じ3手を行います。

## 4. ライセンス（MIT）

MIT License です。全文は LICENSE にあります。
