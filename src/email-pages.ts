import type { Express } from 'express';

// External scripts keep Helmet's default CSP; tokens never appear in GET URLs/logs.
export function installEmailPages(app: Express) {
  app.get(['/verify-email', '/reset-password'], (req, res) => {
    const reset = req.path === '/reset-password';
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).type('html').send(`<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MarioNet 계정 확인</title><link rel="stylesheet" href="/email-action.css"><script src="/email-action.js" defer></script></head>
<body><main><span>MarioNet</span><h1>${reset ? '비밀번호 재설정' : '이메일 인증'}</h1><p>${reset ? '새 비밀번호를 입력해주세요. 변경 후 모든 기기에서 다시 로그인해야 합니다.' : '아래 버튼을 눌러 이메일 인증을 완료해주세요.'}</p>
<form id="action-form">${reset ? '<label for="password">새 비밀번호</label><input id="password" type="password" minlength="12" maxlength="128" autocomplete="new-password" required><label for="confirmation">비밀번호 확인</label><input id="confirmation" type="password" minlength="12" maxlength="128" autocomplete="new-password" required>' : ''}<button id="submit" type="submit">${reset ? '비밀번호 변경' : '이메일 인증 완료하기'}</button></form><p id="result" role="status" aria-live="polite"></p></main></body></html>`);
  });
  app.get('/email-action.css', (_req, res) => res.type('css').send(`:root{color-scheme:dark;font-family:system-ui,'Malgun Gothic',sans-serif;background:#171727;color:#f7f7fc}body{margin:0;min-height:100vh;display:grid;place-items:center}main{margin:24px;padding:36px;max-width:420px;border-radius:22px;background:#24263d}span{color:#6291ff;font-weight:800;font-size:24px}h1{font-size:24px;margin-top:30px}p{color:#bec5dd;line-height:1.9;font-size:14px}button{margin-top:20px;width:100%;background:#2662ec;color:white;border:0;padding:14px;border-radius:12px;cursor:pointer;font:inherit}button:disabled{opacity:.5}input{box-sizing:border-box;width:100%;padding:14px;background:#171727;border:1px solid #677798;border-radius:10px;color:white}label{display:block;margin:16px 0 8px;font-size:13px}`));
  app.get('/email-action.js', (_req, res) => res.type('js').send(`
const token = new URLSearchParams(location.hash.slice(1)).get('token');
history.replaceState(null, '', location.pathname);
const reset = location.pathname === '/reset-password';
const form = document.getElementById('action-form');
const button = document.getElementById('submit');
const result = document.getElementById('result');
if (!token || !/^[a-f0-9]{64}$/.test(token)) { button.disabled = true; result.textContent = '올바른 인증 링크가 아니에요. 앱에서 새 메일을 요청해주세요.'; }
form.addEventListener('submit', async event => {
 event.preventDefault(); if (button.disabled) return;
 const password = document.getElementById('password')?.value;
 if (reset && password !== document.getElementById('confirmation').value) { result.textContent = '비밀번호가 일치하지 않아요.'; return; }
 button.disabled = true; result.textContent = '처리 중이에요…';
 try {
   const response = await fetch('/api/v1/auth/' + (reset ? 'password/reset' : 'email/verification/confirm'), { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(reset ? {token,newPassword:password} : {token}), signal:AbortSignal.timeout(15000) });
   if (response.ok) { form.hidden = true; result.textContent = reset ? '비밀번호를 변경했어요. MarioNet 앱에서 다시 로그인해주세요.' : '인증을 완료했어요. MarioNet 앱으로 돌아가 인증 상태 확인을 눌러주세요.'; }
   else { result.textContent = response.status === 429 ? '요청이 많아요. 잠시 후 다시 시도해주세요.' : '링크가 만료되었거나 이미 사용되었어요. 앱에서 인증 상태를 확인하거나 새 메일을 요청해주세요.'; button.disabled = false; }
 } catch { result.textContent = '서버 응답을 확인하지 못했어요. 앱에서 인증 상태를 확인하거나 다시 시도해주세요.'; button.disabled = false; }
});`));
}
