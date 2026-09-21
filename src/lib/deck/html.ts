import { escapeHtml } from "../util/text";
import { tablePrims, textLines } from "./build";
import { H, W, type DeckSlides, type Prim, type Slide } from "./scene";
import { C, FONTS } from "./theme";

const n = (v: number) => Math.round(v * 100) / 100;

function shape(p: Prim): string {
  switch (p.t) {
    case "rect": return `<rect x="${n(p.x)}" y="${n(p.y)}" width="${n(p.w)}" height="${n(p.h)}"${p.r ? ` rx="${n(p.r)}"` : ""} fill="${p.fill ?? "none"}"${p.stroke ? ` stroke="${p.stroke}" stroke-width="${p.sw ?? 1}"` : ""}${p.opacity !== undefined ? ` opacity="${p.opacity}"` : ""}/>`;
    case "ellipse": return `<ellipse cx="${n(p.x + p.w / 2)}" cy="${n(p.y + p.h / 2)}" rx="${n(p.w / 2)}" ry="${n(p.h / 2)}" fill="${p.fill ?? "none"}"${p.stroke ? ` stroke="${p.stroke}" stroke-width="${p.sw ?? 1}"` : ""}${p.opacity !== undefined ? ` opacity="${p.opacity}"` : ""}/>`;
    case "poly": {
      const pts = p.pts.map(([x, y]) => `${n(x)},${n(y)}`).join(" ");
      return `<${p.open ? "polyline" : "polygon"} points="${pts}" fill="${p.fill ?? "none"}"${p.stroke ? ` stroke="${p.stroke}" stroke-width="${p.sw ?? 1}" stroke-linejoin="round" stroke-linecap="round"` : ""}${p.opacity !== undefined ? ` opacity="${p.opacity}"` : ""}/>`;
    }
    case "line": return `<line x1="${n(p.x1)}" y1="${n(p.y1)}" x2="${n(p.x2)}" y2="${n(p.y2)}" stroke="${p.color}" stroke-width="${p.sw}" stroke-linecap="round"${p.dash ? ' stroke-dasharray="6 5"' : ""}/>`;
    case "text": {
      const f = FONTS[p.font].css;
      return textLines(p).map((l) => `<text x="${n(l.x)}" y="${n(l.top + p.lh / 2 + p.size * 0.36)}" text-anchor="${l.anchor}" font-size="${p.size}" fill="${p.color}" font-family='${f}'${p.bold ? ' font-weight="700"' : ""}${p.italic ? ' font-style="italic"' : ""}${p.spacing ? ` letter-spacing="${p.spacing}"` : ""}>${escapeHtml(l.line)}</text>`).join("");
    }
    case "table": return tablePrims(p).map(shape).join("");
  }
}

function slideHtml(s: Slide, i: number, total: number): string {
  return `<section class="slide" id="s${i + 1}" data-i="${i}" aria-label="Slide ${i + 1} of ${total}: ${escapeHtml(s.title)}">
<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="group" aria-labelledby="t${i + 1}"><title id="t${i + 1}">${escapeHtml(s.title)}</title>${s.prims.map(shape).join("")}</svg>
<aside class="notes"><strong>Speaker notes</strong><p>${escapeHtml(s.notes)}</p></aside>
</section>`;
}

/**
 * A single self-contained HTML file. It presents the deck (arrow keys, F for full screen, O for the overview, N for speaker
 * notes), reads well as a plain scrolling page when script is off, and prints one slide per page, so "Save as PDF" from any
 * browser gives the same slides. When shown inside the app it reports the current slide to its parent and follows #s5 links.
 */
export function buildDeckHtml(d: DeckSlides): string {
  const total = d.slides.length;
  const body = d.slides.map((s, i) => slideHtml(s, i, total)).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(d.title)}</title>
<style>
:root{--navy:${C.navy};--accent:${C.accent};--deep:${C.deep};--line:${C.line};--text:${C.text};--muted:${C.muted};--rail:0px}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{background:radial-gradient(1200px 700px at 70% -10%,#16405c 0,#0b2436 55%,#081b2a 100%);background-attachment:fixed;color:#e4eff6;font:15px/1.5 ${FONTS.sans.css};-webkit-font-smoothing:antialiased}
.bar{position:fixed;top:0;left:0;right:0;height:54px;display:flex;align-items:center;gap:10px;padding:0 16px;background:rgba(8,27,42,.82);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);z-index:6;border-bottom:1px solid rgba(255,255,255,.08)}
.brand{font:700 13px ${FONTS.sans.css};letter-spacing:.28em;color:#7ccbee}
.name{font:600 16px ${FONTS.serif.css};color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:34vw;padding-left:12px;border-left:1px solid rgba(255,255,255,.18)}
.bar .sp{flex:1}
.bar button{font:inherit;font-size:13px;color:#dceaf3;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:6px 11px;cursor:pointer;transition:background .15s,border-color .15s}
.bar button:hover{background:rgba(255,255,255,.14)}
.bar button[aria-pressed=true]{background:var(--accent);border-color:#4fb2d8;color:#fff}
.bar button:focus-visible,.thumb:focus-visible{outline:2px solid #9fd3e8;outline-offset:2px}
.bar .count{font-size:13px;color:#9fd3e8;min-width:64px;text-align:center;font-variant-numeric:tabular-nums}
.bar .nav button{width:34px;padding:6px 0;font-size:16px}
.progress{position:fixed;top:54px;left:0;right:0;height:3px;background:rgba(255,255,255,.06);z-index:6}
.progress i{display:block;height:100%;width:0;background:linear-gradient(90deg,#3aa7d1,#7ccbee);transition:width .3s ease}
.shell{display:flex;padding-top:57px;min-height:100%}
.rail{display:none}
main{flex:1;min-width:0}
.slide{display:block;margin:0 auto;padding:18px 0 8px}
.slide svg{display:block;margin:0 auto;width:min(96vw,1280px);height:auto;background:#fff;border-radius:10px;box-shadow:0 24px 60px rgba(0,0,0,.45),0 2px 6px rgba(0,0,0,.3)}
.notes{width:min(96vw,1280px);margin:12px auto 0;padding:12px 16px;border-radius:10px;background:rgba(255,255,255,.06);color:#c7dbe8;font-size:14px}
.notes strong{color:#7ccbee;font-size:12px;letter-spacing:.14em;text-transform:uppercase}.notes p{margin:4px 0 0}
/* State lives on <html> in classes that no element uses (has-rail, show-notes, overview, full), so no rule can hit <html> itself.
   Script upgrades the page to a presenter: one slide at a time, a thumbnail rail, notes on request. */
.js .slide{display:none}
.js .slide.on{display:block;animation:in .28s ease}
@keyframes in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.js .notes{display:none}.js.show-notes .notes{display:block}
.js .slide svg,.js .notes{width:min(calc(100vw - var(--rail) - 48px),calc((100vh - 130px) * 16 / 9))}
.js.has-rail{--rail:212px}
.js.has-rail .rail{display:flex;flex-direction:column;gap:10px;position:fixed;top:57px;bottom:0;left:0;width:212px;overflow:auto;padding:14px 12px;background:rgba(8,27,42,.55);border-right:1px solid rgba(255,255,255,.07);z-index:4}
.js.has-rail main{margin-left:212px}
.thumb{display:block;width:100%;padding:0;border:0;background:none;text-align:left;cursor:pointer;color:#9fbccd;font:12px/1.3 ${FONTS.sans.css}}
.thumb svg{display:block;width:100%;height:auto;border-radius:5px;background:#fff;opacity:.72;border:2px solid transparent;box-shadow:0 2px 8px rgba(0,0,0,.4);transition:opacity .15s}
.thumb:hover svg{opacity:1}.thumb.on svg{opacity:1;border-color:#7ccbee}.thumb span{display:block;margin:4px 2px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.thumb.on span{color:#fff}
.js.overview .rail{display:none}.js.overview main{margin-left:0;padding:20px 24px 30px}
.js.overview .slide{display:inline-block;width:calc(33.3% - 14px);margin:7px;padding:0;vertical-align:top;cursor:pointer;animation:none}
.js.overview .slide svg{width:100%}.js.overview .notes{display:none!important}
.js.overview .slide.on svg{outline:4px solid #7ccbee}
.js.full .bar,.js.full .progress,.js.full .rail,.js.full .notes{display:none!important}.js.full main{margin:0}.js.full .shell{padding-top:0}
.js.full .slide{padding:0;display:none}.js.full .slide.on{display:block}
.js.full .slide svg{width:min(100vw,calc(100vh * 16 / 9));border-radius:0;box-shadow:none;margin-top:calc((100vh - min(100vw * 9 / 16,100vh)) / 2)}
@page{size:13.333in 7.5in;margin:0}
@media print{
  html,body{background:#fff}.bar,.progress,.rail,.notes{display:none!important}.shell{padding:0}main{margin:0!important}
  .slide,.js .slide,.js.overview .slide{display:block!important;width:13.333in;height:7.5in;margin:0;padding:0;page-break-after:always;break-after:page;animation:none}
  .slide svg,.js .slide svg,.js.overview .slide svg{width:13.333in;height:7.5in;box-shadow:none;border-radius:0;margin:0}
}
@media (max-width:900px){.js.has-rail{--rail:0px}.js.has-rail .rail{display:none}.js.has-rail main{margin-left:0}.name{display:none}}
@media (prefers-reduced-motion:reduce){.js .slide.on{animation:none}.progress i{transition:none}}
</style></head><body>
<div class="bar" role="toolbar" aria-label="Deck controls"><span class="brand">BRODY</span><span class="name">${escapeHtml(d.projectName)}</span><span class="sp"></span>
<span class="nav"><button id="prev" aria-label="Previous slide">&larr;</button> <button id="next" aria-label="Next slide">&rarr;</button></span><span class="count" id="count" aria-live="polite"></span><span class="sp"></span>
<button id="rl" aria-pressed="true">Slides</button><button id="nt" aria-pressed="false">Notes</button><button id="ov" aria-pressed="false">Overview</button><button id="fs">Full screen</button><button id="pr">Print / PDF</button></div>
<div class="progress" aria-hidden="true"><i id="bar"></i></div>
<div class="shell"><nav class="rail" id="rail" aria-label="Slides"></nav>
<main id="deck">
${body}
</main></div>
<script>
(function(){
  var doc=document.documentElement,slides=[].slice.call(document.querySelectorAll('.slide')),cur=0,rail=document.getElementById('rail'),thumbs=[];
  doc.classList.add('js');if(window.innerWidth>900)doc.classList.add('has-rail');
  slides.forEach(function(s,k){var b=document.createElement('button');b.className='thumb';b.setAttribute('aria-label','Go to slide '+(k+1)+': '+s.querySelector('title').textContent);
    var c=s.querySelector('svg').cloneNode(true);c.removeAttribute('aria-labelledby');c.setAttribute('aria-hidden','true');[].forEach.call(c.querySelectorAll('title'),function(t){t.remove()});
    var l=document.createElement('span');l.textContent=(k+1)+'. '+s.querySelector('title').textContent;b.appendChild(c);b.appendChild(l);b.onclick=function(){show(k)};rail.appendChild(b);thumbs.push(b)});
  function show(i,quiet){cur=Math.max(0,Math.min(slides.length-1,i));
    slides.forEach(function(s,k){s.classList.toggle('on',k===cur)});thumbs.forEach(function(t,k){t.classList.toggle('on',k===cur);if(k===cur&&t.scrollIntoView)t.scrollIntoView({block:'nearest'})});
    document.getElementById('count').textContent=(cur+1)+' / '+slides.length;document.getElementById('bar').style.width=((cur+1)/slides.length*100)+'%';
    if(!doc.classList.contains('overview')&&!quiet){var h='#s'+(cur+1);if(location.hash!==h){try{history.replaceState(null,'',h)}catch(e){}}}
    try{if(window.parent&&window.parent!==window)window.parent.postMessage({brodyDeck:{index:cur,total:slides.length}},'*')}catch(e){}}
  function flag(name,on,btn){doc.classList.toggle(name,on);if(btn)document.getElementById(btn).setAttribute('aria-pressed',on)}
  function overview(on){flag('overview',on,'ov');if(!on)window.scrollTo(0,0)}
  document.getElementById('prev').onclick=function(){show(cur-1)};document.getElementById('next').onclick=function(){show(cur+1)};
  document.getElementById('rl').onclick=function(){flag('has-rail',!doc.classList.contains('has-rail'),'rl')};
  document.getElementById('nt').onclick=function(){flag('show-notes',!doc.classList.contains('show-notes'),'nt')};
  document.getElementById('ov').onclick=function(){overview(!doc.classList.contains('overview'))};
  document.getElementById('pr').onclick=function(){window.print()};
  document.getElementById('fs').onclick=function(){if(document.fullscreenElement){document.exitFullscreen()}else if(doc.requestFullscreen){doc.requestFullscreen()}};
  document.addEventListener('fullscreenchange',function(){doc.classList.toggle('full',!!document.fullscreenElement)});
  slides.forEach(function(s,k){s.addEventListener('click',function(){if(doc.classList.contains('overview')){overview(false);show(k)}else if(document.fullscreenElement){show(cur+1)}})});
  document.addEventListener('keydown',function(e){if(e.metaKey||e.ctrlKey||e.altKey)return;
    if(e.key==='ArrowRight'||e.key==='PageDown'||e.key===' '){e.preventDefault();show(cur+1)}
    else if(e.key==='ArrowLeft'||e.key==='PageUp'){e.preventDefault();show(cur-1)}
    else if(e.key==='Home')show(0);else if(e.key==='End')show(slides.length-1);
    else if(e.key==='o'||e.key==='O')overview(!doc.classList.contains('overview'));
    else if(e.key==='n'||e.key==='N')document.getElementById('nt').click();
    else if(e.key==='f'||e.key==='F')document.getElementById('fs').click();
    else if(e.key==='Escape')overview(false);});
  function fromHash(){var m=location.hash.match(/s(\\d+)/);return m?parseInt(m[1],10)-1:0}
  window.addEventListener('hashchange',function(){show(fromHash(),true)});
  show(fromHash());
})();
</script></body></html>`;
}
