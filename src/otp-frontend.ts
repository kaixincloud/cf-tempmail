// OTP viewer homepage in the style of mail.monteam.net:
// paste an email address -> auto-poll the inbox -> show ONLY the latest
// 6-digit code, big, click to copy.
// The mail itself is received by this Worker's email() handler via
// Cloudflare Email Routing on the user's own domain (cloudflare_temp_email
// model). Code extraction happens here in the browser from the mail body
// returned by /api/mails/:id — the backend API stays extraction-free.
// NOTE: no backticks / ${} inside the HTML string on purpose.
export const OTP_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>验证码获取</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>
  * { box-sizing: border-box; }
  body { margin:0; font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; background:#f4f6fb; color:#1c2430; }
  main { max-width:640px; margin:40px auto; padding:0 14px 40px; }
  .card { background:#fff; border-radius:14px; box-shadow:0 2px 12px rgba(20,40,80,.08); padding:26px 22px; text-align:center; }
  h1 { font-size:21px; margin:0 0 6px; }
  .sub { color:#778; font-size:13px; margin-bottom:18px; }
  .row { display:flex; gap:8px; }
  input[type=text] { flex:1; padding:12px; border:1px solid #ccd4e0; border-radius:9px; font-size:15px; min-width:0; }
  button { border:0; border-radius:9px; padding:12px 18px; font-size:15px; cursor:pointer; background:#2f6fed; color:#fff; white-space:nowrap; }
  button:disabled { opacity:.55; }
  .label { margin:26px 0 8px; color:#667; font-size:13px; letter-spacing:2px; }
  .code { font-size:52px; font-weight:800; letter-spacing:10px; background:#eef3ff; border:1px dashed #9db9f5; border-radius:12px; padding:18px 6px 18px 16px; cursor:pointer; user-select:none; }
  .code.fresh { background:#e6f4ea; border-color:#7bc47f; }
  .code.stale { background:#fdf3e3; border-color:#eec27f; }
  .status { margin-top:14px; color:#556; font-size:13px; line-height:1.7; min-height:22px; }
  .err { color:#b3261e; font-size:13px; margin-top:8px; }
  .foot { margin-top:18px; font-size:13px; }
  a { color:#2f6fed; text-decoration:none; }
</style>
</head>
<body>
<main>
  <div class="card">
    <h1>📬 验证码获取</h1>
    <div class="sub">填入邮箱地址，自动获取最新 6 位验证码</div>
    <div class="row">
      <input type="text" id="inEmail" placeholder="输入完整邮箱地址" autocomplete="off">
      <button id="btnGo">开始获取</button>
    </div>
    <div class="label">最新验证码（点击复制）</div>
    <div class="code" id="codeBox" title="点击复制">------</div>
    <div class="status" id="status">请在上方输入邮箱地址查看验证码</div>
    <div class="err" id="err"></div>
    <div class="foot"><a href="/inbox">打开完整收件箱 →</a></div>
  </div>
</main>
<script>
var state = { email: '', epin: '', timer: null, lastMailId: 0, code: '', since: 0 };

function $(id){ return document.getElementById(id); }
function setErr(m){ $('err').textContent = m || ''; }
function setStatus(m){ $('status').textContent = m; }

function parseEmail(raw){
  if (!raw) return '';
  var m = String(raw).match(/[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}/i);
  return m ? m[0].toLowerCase() : '';
}

// Extraction priority: keyword context first, then grouped 123-456,
// then any standalone 6 digits. Subject is searched before body.
function extractFromText(text){
  if (!text) return '';
  var kw = /(?:verification code|security code|one-time|otp|code|验证码|驗證碼|安全码|动态码)/i;
  var m = text.match(new RegExp('(?:' + kw.source + ')[^0-9]{0,40}([0-9]{6})', 'i'));
  if (m) return m[1];
  m = text.match(/([0-9]{6})[^0-9]{0,40}(?:verification|otp|code|验证码)/i);
  if (m) return m[1];
  m = text.match(/\\b([0-9]{3})[- ]([0-9]{3})\\b/);
  if (m) return m[1] + m[2];
  m = text.match(/\\b([0-9]{6})\\b/);
  if (m) return m[1];
  return '';
}
function extractCode(subject, text){
  return extractFromText(subject || '') || extractFromText(text || '');
}

var ERR_CN = { domain_not_allowed:'该域名不在本站收信范围内', invalid_email:'邮箱地址格式不对', epin_required:'该邮箱需要填写 PIN', epin_invalid:'PIN 不正确', not_found:'没有找到这封邮件', mailbox_write_disabled:'该操作已禁用' };
async function api(path){
  var r = await fetch(path);
  var data = null;
  try { data = await r.json(); } catch(e) {}
  if (!r.ok) { var e = new Error((data && ERR_CN[data.error]) || (data && data.error) || ('请求失败（状态码 ' + r.status + '）')); e.code = (data && data.error) || ''; throw e; }
  return data;
}
function qs(){ return '?email=' + encodeURIComponent(state.email) + '&epin=' + encodeURIComponent(state.epin); }

async function poll(){
  if (!state.email) return;
  try {
    var data = await api('/api/mails' + qs());
    var all = data.mail_list || data.result || [];
    setErr('');
    // Only mails that arrived AFTER the address was entered count.
    // Anything older is history and is never shown on this page.
    var gate = state.since - 5000;
    var list = all.filter(function(m){ return m.received_at >= gate; });
    if (!list.length) {
      setStatus(all.length
        ? '正在监听 ' + state.email + ' …等待新邮件（输入之前的历史邮件不显示）'
        : '正在监听 ' + state.email + ' …暂无邮件');
      return;
    }
    // newest first; check up to 5 newest mails for a code
    var checked = 0;
    for (var i = 0; i < list.length && checked < 5; i++) {
      var item = list[i];
      if (item.id === state.lastMailId && state.code) break;
      checked++;
      var detail = await api('/api/mails/' + item.id + qs());
      var mail = detail.result;
      var code = extractCode(mail.subject, mail.text_body);
      if (code) {
        var isNew = item.id !== state.lastMailId;
        state.lastMailId = item.id;
        state.code = code;
        var box = $('codeBox');
        box.textContent = code;
        var ageMin = Math.floor((Date.now() - mail.received_at) / 60000);
        box.className = 'code ' + (ageMin <= 10 ? 'fresh' : 'stale');
        setStatus('来自 ' + (mail.sender || '') + ' · ' + new Date(mail.received_at).toLocaleString() + (ageMin > 10 ? ' · 已超过 10 分钟，可能已过期' : '') + (isNew ? '' : ''));
        return;
      }
    }
    setStatus('正在监听 ' + state.email + ' …最新邮件里暂未找到 6 位验证码');
  } catch(e) {
    if (e.code === 'epin_required' || e.code === 'epin_invalid') {
      var pin = prompt('这个邮箱设有 PIN，请输入：', state.epin || '');
      if (pin !== null) { state.epin = pin; return poll(); }
      stop();
      return;
    }
    setErr('获取失败：' + e.message);
  }
}

function start(email){
  state.email = email;
  state.since = Date.now();
  state.lastMailId = 0;
  state.code = '';
  $('codeBox').textContent = '------';
  $('codeBox').className = 'code';
  localStorage.setItem('otp_email', email);
  setStatus('正在监听 ' + email + ' …');
  stop();
  state.timer = setInterval(poll, 4000);
  poll();
}
function stop(){ if (state.timer) { clearInterval(state.timer); state.timer = null; } }

$('btnGo').onclick = function(){
  var email = parseEmail($('inEmail').value);
  if (!email) { setErr('没识别出邮箱地址，请检查输入'); return; }
  setErr('');
  $('inEmail').value = email;
  start(email);
};
$('inEmail').addEventListener('keydown', function(ev){ if (ev.key === 'Enter') $('btnGo').click(); });
$('codeBox').onclick = function(){
  if (!state.code) return;
  navigator.clipboard.writeText(state.code).then(function(){
    var old = $('codeBox').textContent;
    setStatus('已复制 ' + old);
  });
};

(function init(){
  // An ?email= link is an explicit address hand-off: prefill AND auto-start
  // fetching — but the time gate in start() means only mails arriving after
  // this moment are shown; earlier history is never returned.
  // Without the parameter, a remembered address only prefills the box and
  // fetching still waits for the visitor to click 开始获取.
  var fromUrl = new URLSearchParams(location.search).get('email');
  var saved = fromUrl || localStorage.getItem('otp_email') || '';
  if (saved) {
    var addr = parseEmail(saved) || saved;
    $('inEmail').value = addr;
    if (fromUrl) start(addr);
    else setStatus('已填入邮箱，点「开始获取」查看验证码');
  }
})();
</script>
</body>
</html>
`
