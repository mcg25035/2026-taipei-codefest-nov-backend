import { Router } from 'express';
import { ApiError } from '../errors.js';
import { requireBodyObject, requireString } from '../util.js';

export function classifyRoutes({ classifier, config, limiter }) {
  const router = Router();
  // 文字只在記憶體裡計算，不寫入資料庫或紀錄檔。
  router.post('/classify', (req, res) => {
    const text = requireString(requireBodyObject(req.body), 'text', { max: 5000 });
    if (!limiter.allow(`classify:${req.ip}`, config.classifyPerMinute)) {
      throw new ApiError(429, 'RATE_LIMITED', '請求太頻繁，請稍後再試');
    }
    res.json({ data: { ...classifier.classify(text), threshold: classifier.threshold } });
  });
  return router;
}

const PAGE = `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>問題分類測試</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--ink:#1c2430;--mute:#5b6675;--line:#d9dee5;--bar:#2f6fed;--warn:#a15c00}
@media(prefers-color-scheme:dark){:root{--bg:#14181f;--card:#1d232c;--ink:#e8ecf1;--mute:#9aa6b4;--line:#333c48;--bar:#6c9bff;--warn:#f0b35a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.6 system-ui,"Noto Sans TC",sans-serif}
main{max-width:640px;margin:0 auto;padding:24px 16px 48px}h1{font-size:24px;margin:0 0 4px}p{color:var(--mute);margin:0 0 16px}
textarea{width:100%;min-height:110px;padding:12px;font:inherit;color:inherit;background:var(--card);border:1px solid var(--line);border-radius:10px}
button{font:inherit;cursor:pointer;border-radius:10px;border:1px solid var(--line);background:var(--card);color:inherit;padding:8px 12px}
#go{background:var(--bar);border-color:var(--bar);color:#fff;font-weight:600;padding:10px 20px;margin-top:10px}
#samples{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0}#samples button{font-size:15px}
#result{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-top:18px}
#label{font-size:24px;font-weight:700}#note{color:var(--mute);font-size:15px}#note.low{color:var(--warn)}
.row{display:grid;grid-template-columns:7.5em 1fr 3.2em;gap:8px;align-items:center;font-size:15px;margin-top:8px}
.track{height:10px;background:var(--line);border-radius:5px;overflow:hidden}.fill{height:100%;background:var(--bar)}
.num{text-align:right;font-variant-numeric:tabular-nums}[hidden]{display:none}#err{color:var(--warn)}
</style></head><body><main>
<h1>問題分類測試</h1><p>輸入長輩可能會問的話，看分類器怎麼判斷。文字不會被儲存，請不要輸入真實個資。</p>
<label for="text" hidden>問題內容</label><textarea id="text" maxlength="5000" placeholder="例如：有人打電話說我涉及洗錢要我匯款"></textarea>
<button id="go">分類</button><div id="samples"></div><div id="err" role="alert"></div>
<section id="result" hidden aria-live="polite"><div id="label"></div><div id="note"></div><div id="bars"></div></section>
</main><script>
const LABELS={map_navigation:'地圖與路線',admin_procedure:'行政程序',document_contract:'公文與合約',scam_check:'疑似詐騙',app_usage:'城市通操作',language:'語言與文字',other:'其他',uncategorized:'未分類（交給志工）'};
const SAMPLES=['這張法院寄來的信在講什麼','我要去榮總要坐哪一路公車','有人叫我買遊戲點數給他','台北通密碼忘了','敬老卡要怎麼申請','這個字念什麼'];
const $=(id)=>document.getElementById(id);
async function run(){const text=$('text').value.trim();$('err').textContent='';if(!text)return;
 try{const res=await fetch('/api/v1/classify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})});const json=await res.json();
  if(!res.ok){$('err').textContent=json.error?.message||'發生錯誤';return}render(json.data)}catch{$('err').textContent='連線失敗，請再試一次'}}
function render(d){const auto=d.category!=='uncategorized';$('label').textContent=LABELS[d.category];
 $('note').className=auto?'':'low';$('note').textContent=auto?'信心 '+Math.round(d.confidence*100)+'%，會自動分類':'信心 '+Math.round(d.confidence*100)+'% 低於 '+Math.round(d.threshold*100)+'%，最可能是「'+LABELS[d.predicted]+'」，但不自動分類';
 const bars=$('bars');bars.replaceChildren(...d.scores.map((s)=>{const row=document.createElement('div');row.className='row';const a=document.createElement('span');a.textContent=LABELS[s.category];const t=document.createElement('div');t.className='track';const f=document.createElement('div');f.className='fill';f.style.width=(s.score*100)+'%';t.append(f);const n=document.createElement('span');n.className='num';n.textContent=Math.round(s.score*100)+'%';row.append(a,t,n);return row}));
 $('result').hidden=false}
$('go').onclick=run;$('text').addEventListener('keydown',(e)=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey))run()});
for(const s of SAMPLES){const b=document.createElement('button');b.textContent=s;b.onclick=()=>{$('text').value=s;run()};$('samples').append(b)}
</script></body></html>`;

export function classifyTestPage() {
  const router = Router();
  router.get('/classify-test', (req, res) => res.type('html').send(PAGE));
  return router;
}
