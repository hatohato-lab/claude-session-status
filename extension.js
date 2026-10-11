// Claude Code の各セッションの状態を、VS Code の画面の一番下（ステータスバー）に色付きで並べる拡張。
// 2026-10-11 作成。タブの色や印は Claude Code の拡張しか変えられないため、代わりに画面下に出す。
//
// 読むもの（2つだけ。書き込みはしない）
//   1. ~/.claude/sessions/<pid>.json … Claude Code が書く状態の記録（status は busy / waiting / idle）
//   2. ~/.claude/projects/*/<sessionId>.jsonl の末尾 … タブに出ている名前（custom-title、無ければ ai-title）を知るため
// 設定・フックには触れず、外への通信もしない。
//
// 色の決まり（左のセッション一覧に合わせる）
//   🟢 作業中 / 🔵 入力待ち（許可や質問の答えを待っている） / 🟤 答えが出た（まだ見ていない） / ⚪ 待機（数だけ出す）
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const SESSIONS_DIR = path.join(CONFIG_DIR, 'sessions');
const PROJECTS_DIR = path.join(CONFIG_DIR, 'projects');

const ICON = { busy: '🟢', waiting: '🔵', done: '🟤', idle: '⚪' };
const LABEL = { busy: '作業中', waiting: '入力待ち', done: '答えが出た（まだ見ていない）', idle: '待機' };
const MAX_TITLE = 10;            // 画面下があふれないよう、名前はこの字数で切る
const TAIL_BYTES = 256 * 1024;   // 名前を探すときに読む、会話の記録の末尾の大きさ
const TITLE_RECHECK_MS = 30000;  // 名前の読み直しの間隔（/rename に追いつくため）
const POLL_MS = 2000;            // 監視の取りこぼしに備えた、定期の読み直しの間隔

// ---------------------------------------------------------------- 記録の読み取り

// 記録のプロセスが生きているか。止まったセッションの記録が残っていることがあるため確かめる
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

function readRecords() {
  let names = [];
  try { names = fs.readdirSync(SESSIONS_DIR).filter((n) => n.endsWith('.json')); } catch (e) { return []; }
  const bySid = new Map();
  for (const n of names) {
    let r = null;
    try { r = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, n), 'utf8')); } catch (e) { continue; }   // 書きかけは飛ばす
    if (!r || !r.sessionId || !r.pid || r.kind !== 'interactive' || !alive(r.pid)) continue;
    // 同じ会話が2つの記録に出たときは、新しい方を使う
    const prev = bySid.get(r.sessionId);
    if (!prev || (r.updatedAt || 0) > (prev.updatedAt || 0)) bySid.set(r.sessionId, r);
  }
  return Array.from(bySid.values()).sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
}

// ---------------------------------------------------------------- タブの名前

function findTranscript(sid) {
  try {
    for (const d of fs.readdirSync(PROJECTS_DIR)) {
      const p = path.join(PROJECTS_DIR, d, sid + '.jsonl');
      if (fs.existsSync(p)) return p;
    }
  } catch (e) { /* 見つからなければ記録の名前を使う */ }
  return null;
}

function readTail(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// 文字列の中で最後に出てくる custom-title と ai-title を返す
function lastTitles(text) {
  const out = { custom: null, ai: null };
  const re = /"type":"(custom-title|ai-title)","(?:customTitle|aiTitle)":"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let v = null;
    try { v = JSON.parse('"' + m[2] + '"'); } catch (e) { continue; }
    if (m[1] === 'custom-title') out.custom = v; else out.ai = v;
  }
  return out;
}

// 名前の優先順: 名前を付けた（custom-title）→ 本人が付けた記録の名前 → 自動の題（ai-title）→ 記録の名前
function resolveTitle(r, m) {
  const now = Date.now();
  if (m.title && now - m.titleCheckedAt < TITLE_RECHECK_MS) return m.title;
  m.titleCheckedAt = now;
  if (!m.transcript) m.transcript = findTranscript(r.sessionId);
  let t = m.found || { custom: null, ai: null };
  if (m.transcript) {
    try {
      const size = fs.statSync(m.transcript).size;
      if (size !== m.titleSize) {
        t = lastTitles(readTail(m.transcript, TAIL_BYTES));
        if (!t.custom && !t.ai && !m.fullScanned) {   // 末尾に無いときだけ、1回だけ全体を読む
          t = lastTitles(fs.readFileSync(m.transcript, 'utf8'));
          m.fullScanned = true;
        }
        m.titleSize = size;
        m.found = t;
      }
    } catch (e) { /* 読めないときは前の結果を使う */ }
  }
  m.title = t.custom || (r.nameSource === 'user' && r.name) || t.ai || r.name || r.sessionId.slice(0, 8);
  return m.title;
}

// ---------------------------------------------------------------- 状態の判定

const memo = new Map();   // sessionId -> { lastStatus, unread, title, titleCheckedAt, titleSize, found, transcript, fullScanned }

// 見ているタブの名前（ウィンドウが前面にあり、見ているのが Webview のタブのときだけ）
function watchingLabel() {
  if (!vscode.window.state.focused) return null;
  const g = vscode.window.tabGroups.activeTabGroup;
  const t = g && g.activeTab;
  return (t && t.input instanceof vscode.TabInputWebview) ? t.label : null;
}

// 画面下に出す一覧を作る。shown は busy / waiting / done / idle のどれか
function collect() {
  const recs = readRecords();
  const looking = watchingLabel();
  const live = new Set();
  const list = recs.map((r) => {
    const sid = r.sessionId;
    live.add(sid);
    let m = memo.get(sid);
    if (!m) {   // 拡張を起動した時点で待機中のものは、見たものとして扱う（終わった時刻が分からないため）
      m = { lastStatus: r.status, unread: false, titleCheckedAt: 0 };
      memo.set(sid, m);
    }
    const title = resolveTitle(r, m);
    const st = (r.status === 'busy' || r.status === 'waiting') ? r.status : 'idle';
    const watching = looking !== null && looking === title;
    // 作業中または入力待ちから待機に変わったら「答えが出た」。そのタブを見ていたときは見たものとする
    if (st === 'idle' && m.lastStatus !== 'idle' && !watching) m.unread = true;
    if (st !== 'idle' || watching) m.unread = false;
    m.lastStatus = st;
    return { sid, title, shown: (st === 'idle' && m.unread) ? 'done' : st, since: r.statusUpdatedAt || r.updatedAt || 0 };
  });
  for (const sid of Array.from(memo.keys())) if (!live.has(sid)) memo.delete(sid);
  return list;
}

// ---------------------------------------------------------------- 表示

function short(s) { return s.length > MAX_TITLE ? s.slice(0, MAX_TITLE) + '…' : s; }

function ago(ms) {
  if (!ms) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return s + '秒前から';
  if (s < 3600) return Math.round(s / 60) + '分前から';
  return Math.round(s / 3600) + '時間前から';
}

let items = [];   // 並べ直しやすいよう、毎回の差分ではなく並び全体で持つ
let lastKey = '';

function render() {
  const list = collect();
  const named = list.filter((x) => x.shown !== 'idle');
  const idle = list.filter((x) => x.shown === 'idle');
  const key = JSON.stringify([named.map((x) => [x.sid, x.title, x.shown]), idle.map((x) => x.title)]);
  if (key === lastKey) {   // 並びが同じなら作り直さず、吹き出しの経過時間だけ新しくする
    const bySid = new Map(named.map((x) => [x.sid, x]));
    for (const it of items) {
      if (it.__x && bySid.has(it.__x.sid)) it.__x = bySid.get(it.__x.sid);
      if (it.__idle) it.__idle = idle;
    }
    updateTooltips();
    return;
  }
  lastKey = key;
  items.forEach((it) => it.dispose());
  items = [];
  named.forEach((x, i) => {
    const it = vscode.window.createStatusBarItem('claudeSessionStatus.' + x.sid, vscode.StatusBarAlignment.Left, 1000 - i);
    it.name = 'Claude: ' + x.title;
    it.text = ICON[x.shown] + ' ' + short(x.title);
    it.command = { command: 'claudeSessionStatus.open', title: '開く', arguments: [x.sid] };
    it.__x = x;
    it.show();
    items.push(it);
  });
  if (idle.length) {
    const it = vscode.window.createStatusBarItem('claudeSessionStatus.idle', vscode.StatusBarAlignment.Left, 1000 - named.length);
    it.name = 'Claude: 待機中のセッション';
    it.text = ICON.idle + ' ' + idle.length;
    it.__idle = idle;
    it.show();
    items.push(it);
  }
  updateTooltips();
}

function updateTooltips() {
  for (const it of items) {
    if (it.__x) {
      const x = it.__x;
      it.tooltip = x.title + '\n' + LABEL[x.shown] + '（' + ago(x.since) + '）\n押すと、このセッションのタブを開きます';
    } else if (it.__idle) {
      it.tooltip = '待機中のセッション（' + it.__idle.length + '）\n' + it.__idle.map((x) => '・' + x.title).join('\n');
    }
  }
}

// ---------------------------------------------------------------- 起動と後片づけ

function activate(context) {
  let timer = null;
  const soon = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = null; safeRender(); }, 300); };
  const safeRender = () => { try { render(); } catch (e) { console.error('[claude-session-status]', e); } };

  context.subscriptions.push(vscode.commands.registerCommand('claudeSessionStatus.open', (sid) => {
    const m = memo.get(sid);
    if (m) m.unread = false;   // 押したら見たものとする
    safeRender();
    // Claude Code の拡張の URI。すでにタブで開いていれば、そのタブに移る
    vscode.env.openExternal(vscode.Uri.parse('vscode://anthropic.claude-code/open?session=' + encodeURIComponent(sid)));
  }));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSessionStatus.refresh', () => { lastKey = ''; safeRender(); }));

  try {
    const w = fs.watch(SESSIONS_DIR, soon);
    context.subscriptions.push({ dispose: () => w.close() });
  } catch (e) { /* フォルダがまだ無いときは定期の読み直しだけで動く */ }
  const poll = setInterval(safeRender, POLL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(poll) });
  context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(soon));
  context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabGroups(soon));
  context.subscriptions.push(vscode.window.onDidChangeWindowState(soon));
  context.subscriptions.push({ dispose: () => { items.forEach((it) => it.dispose()); items = []; } });
  safeRender();
}

function deactivate() {}

module.exports = { activate, deactivate, _test: { readRecords, lastTitles, collect, memo } };
