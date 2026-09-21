import { escapeHtml } from "../util/text";
import { tablePrims, textLines } from "./build";
import { H, W, type DeckSlides, type Prim, type Slide } from "./scene";
import { C, FONTS } from "./theme";

const n = (v: number) => Math.round(v * 100) / 100;

function shape(p: Prim): string {
  switch (p.t) {
    case "rect": return `<rect x="${n(p.x)}" y="${n(p.y)}" width="${n(p.w)}" height="${n(p.h)}"${p.r ? ` rx="${n(p.r)}"` : ""} fill="${p.fill ?? "none"}"${p.stroke ? ` stroke="${p.stroke}" stroke-width="${p.sw ?? 1}"` : ""}${p.opacity !== undefined ? ` opacity="${p.opacity}"` : ""}/>`;
    case "ellipse": return `<ellipse cx="${n(p.x + p.w / 2)}" cy="${n(p.y + p.h / 2)}" rx="${n(p.w / 2)}" ry="${n(p.h / 2)}" fill="${p.fill ?? "none"}"${p.stroke ? ` stroke="${p.stroke}" stroke-width="${p.sw ?? 1}"` : ""}/>`;
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
 * A single self-contained HTML file. It presents the deck (arrow keys, F for full screen, O for the overview), reads well
 * as a scrolling page, and prints one slide per page, so "Save as PDF" from any browser gives the same slides.
 */
export function buildDeckHtml(d: DeckSlides): string {
  const total = d.slides.length;
  const body = d.slides.map((s, i) => slideHtml(s, i, total)).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(d.title)}</title>
<style>
:root{--navy:${C.navy};--accent:${C.accent};--bg:${C.bg};--line:${C.line};--text:${C.text};--muted:${C.muted}}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{background:#0f202d;color:var(--text);font:15px/1.5 ${FONTS.sans.css}}
.bar{position:fixed;top:0;left:0;right:0;height:52px;display:flex;align-items:center;gap:14px;padding:0 18px;background:${C.navyDark};color:#dceaf3;z-index:5;border-bottom:3px solid var(--accent)}
.bar .name{font:700 17px ${FONTS.serif.css};color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:46vw}
.bar .count{margin-left:auto;font-size:14px;color:#9fd3e8}
.bar button{font:inherit;font-size:14px;color:#fff;background:#24566f;border:1px solid #3a7a99;border-radius:8px;padding:6px 12px;cursor:pointer}
.bar button:hover,.bar button:focus-visible{background:var(--accent);outline:2px solid #9fd3e8;outline-offset:1px}
main{padding-top:52px;min-height:100%}
.slide{display:none;margin:0 auto;padding:18px 0 8px}
.slide.on{display:block}
.slide svg{display:block;margin:0 auto;width:min(96vw,calc((100vh - 170px) * 16 / 9));height:auto;background:#fff;border-radius:6px;box-shadow:0 10px 40px rgba(0,0,0,.45)}
.notes{width:min(96vw,calc((100vh - 170px) * 16 / 9));margin:12px auto 0;color:#c7dbe8;font-size:14px}
.notes p{margin:2px 0 0}
.overview main{padding:70px 22px 30px}
.overview .slide{display:inline-block;width:calc(33.3% - 12px);margin:6px;padding:0;vertical-align:top;cursor:pointer}
.overview .slide svg{width:100%;box-shadow:0 4px 16px rgba(0,0,0,.4)}
.overview .notes{display:none}
.overview .slide.on svg{outline:4px solid var(--accent)}
.full .bar,.full .notes{display:none}.full main{padding-top:0}.full .slide svg{width:min(100vw,calc(100vh * 16 / 9));border-radius:0;margin-top:calc((100vh - min(100vw * 9 / 16,100vh)) / 2)}
.full .slide{padding:0}
@page{size:13.333in 7.5in;margin:0}
@media print{
  body{background:#fff}.bar,.notes{display:none}main{padding:0}
  .slide,.overview .slide{display:block!important;width:13.333in;height:7.5in;margin:0;padding:0;page-break-after:always;break-after:page}
  .slide svg,.overview .slide svg{width:13.333in;height:7.5in;box-shadow:none;border-radius:0;margin:0}
}
</style></head><body>
<div class="bar" role="toolbar" aria-label="Deck controls"><span class="name">${escapeHtml(d.projectName)}</span>
<button id="prev" aria-label="Previous slide">&larr;</button><button id="next" aria-label="Next slide">&rarr;</button>
<button id="ov" aria-pressed="false">Overview</button><button id="fs">Full screen</button><button id="pr">Print / PDF</button>
<span class="count" id="count" aria-live="polite"></span></div>
<main id="deck">
${body}
</main>
<script>
(function(){
  var slides=[].slice.call(document.querySelectorAll('.slide')),cur=0,root=document.body;
  function show(i){cur=Math.max(0,Math.min(slides.length-1,i));slides.forEach(function(s,k){s.classList.toggle('on',k===cur)});
    document.getElementById('count').textContent=(cur+1)+' / '+slides.length;if(!root.classList.contains('overview')){var h='#s'+(cur+1);if(location.hash!==h)history.replaceState(null,'',h)}}
  function overview(on){root.classList.toggle('overview',on);document.getElementById('ov').setAttribute('aria-pressed',on);if(!on)window.scrollTo(0,0);}
  document.getElementById('prev').onclick=function(){show(cur-1)};document.getElementById('next').onclick=function(){show(cur+1)};
  document.getElementById('ov').onclick=function(){overview(!root.classList.contains('overview'))};
  document.getElementById('pr').onclick=function(){window.print()};
  document.getElementById('fs').onclick=function(){var d=document.documentElement;if(document.fullscreenElement){document.exitFullscreen()}else if(d.requestFullscreen){d.requestFullscreen()}};
  document.addEventListener('fullscreenchange',function(){root.classList.toggle('full',!!document.fullscreenElement)});
  slides.forEach(function(s,k){s.addEventListener('click',function(){if(root.classList.contains('overview')){overview(false);show(k)}else if(document.fullscreenElement){show(cur+1)}})});
  document.addEventListener('keydown',function(e){
    if(e.key==='ArrowRight'||e.key==='PageDown'||e.key===' '){e.preventDefault();show(cur+1)}
    else if(e.key==='ArrowLeft'||e.key==='PageUp'){e.preventDefault();show(cur-1)}
    else if(e.key==='Home')show(0);else if(e.key==='End')show(slides.length-1);
    else if(e.key==='o'||e.key==='O')overview(!root.classList.contains('overview'));
    else if(e.key==='f'||e.key==='F')document.getElementById('fs').click();
    else if(e.key==='Escape')overview(false);});
  var start=parseInt((location.hash.match(/s(\\d+)/)||[])[1]||'1',10)-1;show(isNaN(start)?0:start);
})();
</script></body></html>`;
}
