// Inbox page — query by known address only.
// The page exposes nothing: no domain list, no generated addresses, no
// mailbox creation. The visitor types a full email address they already
// know (under one of the configured domains) and only then can read mail.
// NOTE: no backticks / ${} inside the HTML string on purpose.
export const FRONTEND_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>收件箱查询</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>
  * { box-sizing: border-box; }
  body { margin:0; font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; background:#f4f6fb; color:#1c2430; }
  header { background:#2f6fed; color:#fff; padding:14px 20px; font-size:19px; font-weight:700; }
  main { max-width:860px; margin:24px auto; padding:0 14px 40px; }
  .card { background:#fff; border-radius:12px; box-shadow:0 2px 10px rgba(20,40,80,.07); padding:20px; margin-bottom:16px; }
  .row { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
  input { padding:11px; border:1px solid #ccd4e0; border-radius:8px; font-size:15px; }
  input.email { flex:1; min-width:220px; }
  button { border:0; border-radius:8px; padding:11px 18px; font-size:14px; cursor:pointer; background:#2f6fed; color:#fff; }
  button.secondary { background:#e8edf5; color:#24304a; }
  button.danger { background:#e5484d; }
  h2 { font-size:17px; margin:0 0 6px; }
  .meta { color:#778; font-size:13px; margin-top:10px; }
  .err { color:#b3261e; font-size:13px; margin-top:8px; }
  .mail { border-top:1px solid #edf0f5; padding:12px 6px; cursor:pointer; display:flex; gap:10px; }
  .mail:hover { background:#f7faff; }
  .mail .from { font-weight:600; min-width:150px; max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .mail .subj { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .mail .time { color:#889; font-size:12px; white-space:nowrap; }
  .empty { color:#889; text-align:center; padding:26px 0; }
  .detail { white-space:pre-wrap; word-break:break-word; font-size:14px; line-height:1.6; }
  iframe.mailhtml { width:100%; height:420px; border:1px solid #e3e8f0; border-radius:8px; }
  .hidden { display:none; }
  footer { text-align:center; color:#99a; font-size:12px; padding:18px 0 30px; }
</style>
</head>
<body>
<header>收件箱查询</header>
<main>
  <div class="card">
    <div class="row">
      <input class="email" id="inEmail" placeholder="输入完整邮箱地址" autocomplete="off">
      <input id="inEpin" placeholder="PIN（可选）" maxlength="32" style="width:130px">
      <button id="btnQuery">查询</button>
      <label style="font-size:13px;color:#667"><input type="checkbox" id="chkAuto" checked> 自动刷新（5 秒）</label>
    </div>
    <div class="meta" id="meta">输入你已知的邮箱地址后查询，本站不提供地址列表。</div>
    <div class="err" id="err"></div>
  </div>

  <div class="card hidden" id="listCard">
    <h2>收件箱</h2>
    <div id="mailList"><div class="empty">暂无邮件</div></div>
  </div>

  <div class="card hidden" id="detailCard">
    <div class="row">
      <h2 style="flex:1" id="dSubject"></h2>
      <button class="danger" id="btnDelMail">删除这封</button>
      <button class="secondary" id="btnCloseDetail">关闭</button>
    </div>
    <div class="meta" id="dMeta"></div>
    <div style="height:10px"></div>
    <div class="detail" id="dText"></div>
    <iframe class="mailhtml hidden" id="dHtml" sandbox=""></iframe>
  </div>

  <footer><a href="/" style="color:#2f6fed;text-decoration:none">← 去取验证码</a></footer>
</main>
<script>
var state = { email: '', epin: '', currentMail: null, timer: null };

function $(id){ return document.getElementById(id); }
function err(m){ $('err').textContent = m || ''; }
function qs(){ return '?email=' + encodeURIComponent(state.email) + '&epin=' + encodeURIComponent(state.epin); }

function parseEmail(raw){
  if (!raw) return '';
  var m = String(raw).match(/[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}/i);
  return m ? m[0].toLowerCase() : '';
}

var ERR_CN = { domain_not_allowed:'该域名不在本站收信范围内', invalid_email:'邮箱地址格式不对', epin_required:'该邮箱需要填写 PIN', epin_invalid:'PIN 不正确', not_found:'没有找到这封邮件', mailbox_write_disabled:'该操作已禁用' };
async function api(path, opts){
  var r = await fetch(path, opts);
  var data = null;
  try { data = await r.json(); } catch(e) {}
  if (!r.ok) throw new Error((data && ERR_CN[data.error]) || (data && data.error) || ('请求失败（状态码 ' + r.status + '）'));
  return data;
}

async function refresh(){
  if (!state.email) return;
  try {
    var data = await api('/api/mails' + qs());
    renderList(data.mail_list || data.result || []);
    err('');
  } catch(e) { err('查询失败：' + e.message); }
}

function fmtTime(ts){
  var d = new Date(ts);
  function p(n){ return (n<10?'0':'') + n; }
  return p(d.getMonth()+1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function renderList(list){
  var box = $('mailList');
  if (!list.length) { box.innerHTML = '<div class="empty">该地址暂无邮件</div>'; return; }
  box.innerHTML = '';
  list.forEach(function(m){
    var div = document.createElement('div');
    div.className = 'mail';
    var from = document.createElement('div'); from.className = 'from'; from.textContent = m.sender_name ? (m.sender_name + ' <' + m.sender + '>') : m.sender;
    var subj = document.createElement('div'); subj.className = 'subj'; subj.textContent = m.subject || '(无主题)';
    var time = document.createElement('div'); time.className = 'time'; time.textContent = fmtTime(m.received_at);
    div.appendChild(from); div.appendChild(subj); div.appendChild(time);
    div.onclick = function(){ openMail(m.id); };
    box.appendChild(div);
  });
}

async function openMail(id){
  try {
    var data = await api('/api/mails/' + id + qs());
    var m = data.result;
    state.currentMail = m.id;
    $('detailCard').classList.remove('hidden');
    $('dSubject').textContent = m.subject || '(无主题)';
    $('dMeta').textContent = '发件人：' + (m.sender_name ? m.sender_name + ' <' + m.sender + '>' : m.sender) + '　时间：' + new Date(m.received_at).toLocaleString();
    if (m.html_body) {
      $('dText').textContent = '';
      var f = $('dHtml');
      f.classList.remove('hidden');
      f.srcdoc = m.html_body;
    } else {
      $('dHtml').classList.add('hidden');
      $('dText').textContent = m.text_body || '';
    }
    $('detailCard').scrollIntoView({ behavior:'smooth' });
  } catch(e) { err('打开邮件失败：' + e.message); }
}

function startQuery(){
  var email = parseEmail($('inEmail').value);
  if (!email) { err('没识别出邮箱地址，请输完整地址'); return; }
  err('');
  state.email = email;
  state.epin = $('inEpin').value.trim();
  localStorage.setItem('inbox_email', email);
  $('inEmail').value = email;
  $('meta').textContent = '正在查询 ' + email + ' …';
  $('listCard').classList.remove('hidden');
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(function(){ if ($('chkAuto').checked) refresh(); }, 5000);
  refresh().then(function(){ $('meta').textContent = '查询地址：' + email; });
}

$('btnQuery').onclick = startQuery;
$('inEmail').addEventListener('keydown', function(ev){ if (ev.key === 'Enter') startQuery(); });
$('btnCloseDetail').onclick = function(){ $('detailCard').classList.add('hidden'); };
$('btnDelMail').onclick = async function(){
  if (!state.currentMail) return;
  try { await api('/api/mails/' + state.currentMail + qs(), { method:'DELETE' }); $('detailCard').classList.add('hidden'); await refresh(); }
  catch(e){ err('删除失败：' + e.message); }
};

(function init(){
  // ?email=<addr> link: prefill AND auto-run the query (this page is the
  // full-history mailbox viewer, so no time gate here). A remembered
  // address without the parameter only prefills; 查询 waits for a click.
  var fromUrl = new URLSearchParams(location.search).get('email');
  var saved = fromUrl || localStorage.getItem('inbox_email') || '';
  if (saved) {
    $('inEmail').value = parseEmail(saved) || saved;
    if (fromUrl) startQuery();
  }
})();
</script>
</body>
</html>
`
