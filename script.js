// ===== Utility =====
const SUITS=["♠","♥","♦","♣"]; const RANKS=["A","2","3","4","5","6","7","8","9","10","J","Q","K"]; const RVAL=Object.fromEntries(RANKS.map((r,i)=>[r,i+1]));
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
function scoringValue(rank){ if(rank==='10')return 30; if(['J','Q','K'].includes(rank))return 10; if(rank==='A')return 1; return Number(rank); }
function makeDeck(n){ const d=[]; for(let k=0;k<n;k++){ for(const s of SUITS){ for(const r of RANKS){ d.push({r,s}); } } } return shuffle(d); }
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); const ai=a[i]; const aj=a[j]; a[i]=aj; a[j]=ai; } return a; }

// ===== Names for AI =====
const MALE_NAMES=["Greg","Paul","Alex","Jordan","Chris","Logan","Dylan","Corey","Brett","Terry"]; 
const FEMALE_NAMES=["Mary","Alicia","Ashley","Veronica","Kelly","Dana","Leslie","Sasha","Quinn","Avery"]; 
const AI_NAMES=[...MALE_NAMES,...FEMALE_NAMES];

// ===== Settings (with persistence) =====
const settings = {
  pauseBefore:false, warnOn:false, warnThresh:5,
  showSuits:false, miniTap:false, miniCorner:'tr', miniHidden:false,
  showHintBtn:true,
  cardFaceTheme: 'classic',        // 'classic' | 'dark'
  autoPlayCopies:false,            // NEW: auto-play all copies except A/2/10
  // appearance
  tableColor:'#0a5a3c',            // NEW: felt base
  tableFavorites:[],               // NEW
  cardBack:'solid-blue',
  cardBackFavorites:[],            // NEW: array of {bg:string} (CSS background)
  cardBackCustomBg:''              // NEW: holds current custom background when using custom
};

function loadSettings(){
  try{
    const s = JSON.parse(localStorage.getItem('tens_settings') || 'null');
    if(s){ Object.assign(settings, s); }
  }catch(e){}

  // Normalize any legacy card-back names
  if (settings.cardBack === 'blueflame' || settings.cardBack === 'wave' || settings.cardBack === 'classic'){
    settings.cardBack = 'solid-blue';
  }
  if (typeof settings.showHintBtn !== 'boolean') settings.showHintBtn = true;
  if (typeof settings.autoPlayCopies !== 'boolean') settings.autoPlayCopies = false;

  // Normalize card face theme and apply
  if (settings.cardFaceTheme !== 'dark') settings.cardFaceTheme = 'classic';
  document.body.dataset.cardface = settings.cardFaceTheme;

  // Apply table/chrome and cardback immediately
  applyTableTheme(settings.tableColor);
  applyCardBackToBody();

  // Persist back any fills/defaults
  saveSettings();
}

function saveSettings(){
  try{
    localStorage.setItem('tens_settings', JSON.stringify(settings));
  }catch(e){}
  // Re-apply on save
  applyTableTheme(settings.tableColor);
  applyCardBackToBody();
  document.body.dataset.cardback = settings.cardBack || 'solid-blue';
  document.body.dataset.cardface = settings.cardFaceTheme;
}

// derive felt-dark + chrome vars from a base color
function applyTableTheme(hex){
  // crude lighten/darken without dependencies
  function hexToRgb(h){ h=h.replace('#',''); if(h.length===3) h=h.split('').map(x=>x+x).join('');
    const n=parseInt(h,16); return {r:(n>>16)&255, g:(n>>8)&255, b:n&255}; }
  function rgbToHex(r,g,b){ const c=(r<<16)|(g<<8)|b; return '#'+c.toString(16).padStart(6,'0'); }
  function clamp(x){ return Math.max(0,Math.min(255,Math.round(x))); }
  function mix(a,b,t){ return clamp(a+(b-a)*t); }
  const {r,g,b}=hexToRgb(hex);
  // darker for --felt-dark
  const dark = rgbToHex(mix(r,0,.35), mix(g,0,.35), mix(b,0,.35));
  // chrome bg = slightly transparent felt
  const chrome = `color-mix(in srgb, ${hex} 88%, black)`;
  document.documentElement.style.setProperty('--felt', hex);
  document.documentElement.style.setProperty('--felt-dark', dark);
  document.documentElement.style.setProperty('--chrome-bg', chrome);
  document.documentElement.style.setProperty('--chrome-border', 'rgba(255,255,255,.15)');
}

function applyCardBackToBody(){
  // If using a custom favorite, we set data-cardback="custom" and provide --cardback-custom-bg
  if (settings.cardBack === 'custom' && settings.cardBackCustomBg){
    document.body.dataset.cardback = 'custom';
    document.body.style.setProperty('--cardback-custom-bg', settings.cardBackCustomBg);
  } else {
    document.body.dataset.cardback = settings.cardBack || 'solid-blue';
    document.body.style.removeProperty('--cardback-custom-bg');
  }
}

// ===== State =====
const state = {
  players: [],
  pile: [],
  currentValue: null,
  currentCount: 0,
  turn: 0,
  roundActive: false,
  dealer: -1,
  matchActive: true,
  mustDeclare: new Set(),
  warnedAt: new Map(),
  roundStats: null,
  aiAdaptive: 'medium',
  uiLock: false,           // ← lock human input during forced flows (e.g., blind flip)
  roundHistory: [],         // ← NEW: per-round points history [ [p0,p1,...], [p0,p1,...], ... ]
  pickupsTotal: new Map(), 
};

function freshPlayers(n){
  const needAI=Math.max(0,n-1);
  const pool=shuffle([...AI_NAMES]);
  const chosen=[]; for(let i=0;i<needAI;i++){ chosen.push(pool[i % pool.length]); }
  state.players=Array.from({length:n},(_,i)=>({id:i,name: i===0 ? 'You' : `${chosen[i-1]} (AI)`, isHuman:i===0, hand:[], slots:[], score:0}));
}
function nextDealer(){ state.dealer=(state.dealer+1)%state.players.length; }

function resetMatch(){
  state.players.forEach(p=>p.score=0);
  state.dealer=-1;
  state.matchActive=true;
  logClear();
  updateScores();
  state.warnedAt.clear();
  state.roundHistory = []; // ← reset stats history
  state.pickupsTotal = new Map();
}

// ===== Deal (ensure 11 hand + 4 up/4 down) =====
// Build exactly the number of cards needed: players * 19.
function ensureDeckSizeFor(nPlayers){
  const needEach = 11 + 8;                // 19 per player
  const needTotal = nPlayers * needEach;
  const decksNeeded = Math.ceil(needTotal / 52);

  // Build a combined shoe of N full decks, fully shuffled
  // (You already have makeDeck(n) that returns n full decks shuffled together)
  const shoe = makeDeck(decksNeeded);     // length = decksNeeded * 52

  // We’ll deal exactly needTotal cards from the end with .pop()
  // Remaining cards in `shoe` are not used (excluded from the game)
  return shoe;
}

function dealRound(){ const d=ensureDeckSizeFor(state.players.length); for(const p of state.players){ p.hand=[]; p.slots=[]; }
  for(const p of state.players){ for(let i=0;i<4;i++){ const down=d.pop(); const up=d.pop(); p.slots.push({down,up}); } }
  for(const p of state.players){ for(let i=0;i<11;i++){ p.hand.push(d.pop()); } }
  state.pile=[]; state.currentValue=null; state.currentCount=0; state.roundActive=true; state.mustDeclare.clear(); state.warnedAt.clear(); state.turn=(state.dealer+1)%state.players.length; state.roundStats={ pickups:new Map() };
}

// ===== Helpers =====
function faceUpCards(p){ const arr=[]; p.slots.forEach((s,idx)=>{ if(s && s.up){ arr.push(Object.assign({},s.up,{_slot:idx})); } }); return arr; }
function faceDownCount(p){ return p.slots.filter(s=>!!(s&&s.down)).length; }
function removeFaceUpOfRank(p,rank,count){ const removed=[]; for(const s of p.slots){ if(count && s && s.up && s.up.r===rank){ removed.push(s.up); s.up=null; count--; if(count===0) break; } } return removed; }
function countFaceUpRank(p,rank){ let n=0; for(const s of p.slots){ if(s && s.up && s.up.r===rank) n++; } return n; }
function countHandRank(p,rank){ return p.hand.filter(c=>c && c.r===rank).length; }

// ===== Render =====
function makeCardEl(card, small, hidden){
  const d = document.createElement('div');
  const rr = (card && card.r) || '';
  const ss = (card && card.s) || '♠';

  d.className = 'card' + (small ? ' small' : '') + (hidden ? ' faceDown' : '');
  if (!hidden) {
    // Show suits only if the setting is on
    d.textContent = rr ? (settings.showSuits ? (rr + ss) : rr) : '';
    if (ss === '♥' || ss === '♦') d.classList.add('red');
  }
  return d;
}
function groupByRank(cards){ const m={}; for(const c of cards){ if(!c||!c.r) continue; (m[c.r]||(m[c.r]=[])).push(c); } return m; }
function canPlayRank(rank){ if(rank==='10') return true; if(state.currentValue===null) return true; return RVAL[rank] <= state.currentValue; }

function render(){
  const aiWrap = document.getElementById('aiTop'), meWrap = document.getElementById('human');
  aiWrap.innerHTML = ''; meWrap.innerHTML = '';

  const isMobile = window.innerWidth <= 600;

  state.players.forEach((p, idx) => {
    const area = document.createElement('div');
    area.className = 'playerArea' + (p.isHuman ? ' me' : '');
    if (idx === state.turn && state.roundActive) area.classList.add('turnGlow');

    const hdr = document.createElement('div');
    hdr.className = 'playerHeader';
    const left = document.createElement('div');
    left.innerHTML = `<b>${p.name}</b> <span class="badge">hand: ${p.hand.filter(Boolean).length}</span>`;
    const right = document.createElement('div');
    right.innerHTML = `<span class="badge">table: ${faceUpCards(p).length + faceDownCount(p)}</span>`;
    hdr.append(left, right);
    area.append(hdr);

    const slotRow = document.createElement('div');
    slotRow.className = 'slotRow';
    slotRow.style.display = 'grid';
    slotRow.style.gridTemplateColumns = 'repeat(4, 56px)';

    p.slots.forEach((s, slotIdx) => {
      const col = document.createElement('div');
      col.style.height = '76px';
      col.style.position = 'relative';

      if (s && s.down) {
        const downEl = makeCardEl({ r: '', s: '♠' }, !p.isHuman, true);
        downEl.style.position = 'absolute';
        downEl.style.top = '10px';
        downEl.style.left = '0';
        downEl.style.transform = 'scale(0.98)';
        if (p.isHuman && state.turn === p.id && state.roundActive && !(s.up)) {
          downEl.classList.add('playable');
          downEl.title = 'Flip this face-down card';
          downEl.onclick = function(){
            if(state.uiLock) return;               // ← guard while locked
            tryFlipFaceDownSlot(slotIdx);
          };
        }
        col.append(downEl);
      }

      if (s && s.up) {
        const upEl = makeCardEl(s.up, !p.isHuman, false);
        upEl.style.position = 'absolute';
        upEl.style.top = '0';
        upEl.style.left = '0';
        upEl.style.zIndex = '2';
        upEl.style.boxShadow = '0 2px 10px rgba(0,0,0,.25)';
        if (p.isHuman && state.turn === p.id && state.roundActive) {
          const qtyFU = countFaceUpRank(p, s.up.r);
          upEl.classList.add('playable');
          upEl.onclick = function(){
            if(state.uiLock) return;               // ← guard while locked
            promptCountAndPlay(s.up.r, 'faceUp', qtyFU);
          };
        }
        col.append(upEl);
      }

      if (!(s && (s.up || s.down))) {
        const empty = document.createElement('div');
        empty.style.height = '68px';
        col.append(empty);
      }
      slotRow.append(col);
    });

    const fuSec = document.createElement('div');
    fuSec.className = 'section';
    fuSec.innerHTML = '<h3>Table (4 up over 4 down)</h3>';
    area.append(fuSec);
    area.append(slotRow);

    if (p.isHuman) {
      const handSec = document.createElement('div');
      handSec.className = 'section';
      handSec.innerHTML = '<h3>Your Hand</h3>';

      const handRow = document.createElement('div');
      handRow.className = 'stack';

      const groups = groupByRank(p.hand);
      Object.keys(groups)
        .sort((a,b) => RVAL[a]-RVAL[b])
        .forEach(function(r){
          const cardsOfRank = groups[r].filter(Boolean);
          const qty = cardsOfRank.length;

          const wrap = document.createElement('div');
          wrap.style.display = 'flex';
          wrap.style.gap = '4px';

          cardsOfRank.forEach(function(card){
            const el = makeCardEl(card, false, false);
            if (canPlayRank(r)) el.classList.add('playable');
            el.onclick = function(){
              if(state.uiLock) return;             // ← guard while locked
              promptCountAndPlay(r, 'hand', qty);
            };
            wrap.append(el);
          });

          handRow.append(wrap);
        });

      area.append(handSec);
      area.append(handRow);

      // Hint button relocation/visibility (unchanged)
      (function handleHintButton(){
        const hintBtn = document.getElementById('hintBtn');
        const controls = document.querySelector('.controls');

        let holder = document.getElementById('mobileHintHolder');
        if (!settings.showHintBtn){
          if (hintBtn){
            hintBtn.style.display = 'none';
            if (controls && hintBtn.parentElement !== controls){
              controls.appendChild(hintBtn);
            }
          }
          if (holder) holder.remove();
          return;
        }

        if (!hintBtn) return;
        hintBtn.style.display = ''; // show

        if (isMobile) {
          if (!holder) {
            holder = document.createElement('div');
            holder.id = 'mobileHintHolder';
            holder.style.marginTop = '10px';
            holder.style.display = 'flex';
            holder.style.alignItems = 'center';
            holder.style.justifyContent = 'flex-start';
            area.append(holder);
          }
          if (hintBtn.parentElement !== holder) {
            holder.appendChild(hintBtn);
            hintBtn.style.width = '100%';
          }
        } else {
          if (hintBtn.parentElement !== controls) {
            controls.appendChild(hintBtn);
            hintBtn.style.width = 'auto';
          }
          if (holder) holder.remove();
        }
      })();
    }

    (p.isHuman ? meWrap : aiWrap).append(area);
  });

  const pileStack = document.getElementById('pileStack');
  pileStack.innerHTML = '';
  state.pile.filter(Boolean).forEach(function(c){
    const el = makeCardEl(c, true, false);
    el.style.opacity = 1;
    pileStack.append(el);
  });

  document.getElementById('pileInfo').textContent =
    state.currentValue ? (RANKS[state.currentValue-1] + ' × ' + state.currentCount) : 'Fresh start';

  updateScores();
  renderMiniPile();
}

// ==== Theme helpers (felt gradient from a single base color) ====
function hexToRgb(h){
  const s = h.replace('#','');
  const b = s.length===3 ? s.split('').map(ch=>ch+ch).join('') : s;
  const n = parseInt(b,16);
  return {r:(n>>16)&255, g:(n>>8)&255, b:n&255};
}
function rgbToHex({r,g,b}){
  const h = (x)=>x.toString(16).padStart(2,'0');
  return '#'+h(r)+h(g)+h(b);
}
function darken(hex, factor){ // factor 0..1 (e.g., .8)
  const {r,g,b} = hexToRgb(hex);
  return rgbToHex({r:Math.round(r*factor), g:Math.round(g*factor), b:Math.round(b*factor)});
}
function applyFelt(hex){
  const dark = darken(hex, 0.75);
  document.documentElement.style.setProperty('--felt', hex);
  document.documentElement.style.setProperty('--felt-dark', dark);
}

// ===== Logging & UI Helpers =====
function log(msg){ const el=document.getElementById('log'); const p=document.createElement('div'); p.textContent=msg; el.append(p); el.scrollTop=el.scrollHeight; }
function labelActive(cv,cc){ const v=(typeof cv==='number'?cv:state.currentValue); const c=(typeof cc==='number'?cc:state.currentCount); return v? (RANKS[v-1]+' × '+c) : 'Fresh start'; }
function logAction(msg,opts){ opts=opts||{}; const el=document.getElementById('log'); const row=document.createElement('div'); const text=document.createElement('div'); text.textContent=msg; row.append(text); const showSnap=(document.getElementById('logSnapshots')&&document.getElementById('logSnapshots').checked); if(showSnap){ const snap=document.createElement('div'); snap.className='stack'; const cards=(opts.snapshotCards||[]).filter(Boolean); cards.forEach(function(c){ snap.append(makeCardEl(c,true,false)); }); if(cards.length) row.append(snap); } el.append(row); el.scrollTop=el.scrollHeight; }
function logBoardState(){ const label=state.currentValue? (RANKS[state.currentValue-1]+' × '+state.currentCount) : 'Fresh start'; log('Board → '+label+' (cards: '+state.pile.length+')'); }
function logClear(){ document.getElementById('log').innerHTML=''; }
function toast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); setTimeout(function(){ t.classList.remove('show'); },1600); }
function enableHumanChoices(){ render(); }
function isPauseOn(){ return !!settings.pauseBefore; }
function showPauseModal(cards,title){ return new Promise(function(resolve){ const pk=document.getElementById('picker'); pk.innerHTML=''; const h=document.createElement('div'); h.className='row'; const b=document.createElement('b'); b.textContent=title; h.append(b); pk.append(h); const stack=document.createElement('div'); stack.className='stack'; (cards||[]).filter(Boolean).forEach(function(c){ stack.append(makeCardEl(c,true,false)); }); pk.append(stack); const btn=document.createElement('button'); btn.textContent='Continue'; btn.onclick=function(){ pk.style.display='none'; resolve(); }; pk.append(btn); pk.style.display='flex'; }); }
async function maybePauseBefore(kind, cards, actorName){
  // Only honor the pause for human turns; AI should never be blocked.
  if (!isPauseOn()) return;

  const current = state.players[state.turn];
  const isHuman = current && current.isHuman;
  if (!isHuman) return;

  const who = actorName ? (actorName + ' is ') : '';
  const title = (kind === 'clear')
    ? (who + 'about to clear the pile')
    : (who + 'about to pick up the pile');

  await showPauseModal(cards, title);
}
function showRevealModal(card){ return new Promise(function(resolve){ const pk=document.getElementById('picker'); pk.innerHTML=''; const h=document.createElement('div'); h.className='row'; const b=document.createElement('b'); b.textContent='You flipped '+((card&&card.r)||''); h.append(b); pk.append(h); const stack=document.createElement('div'); stack.className='stack'; stack.append(makeCardEl(card,true,false)); pk.append(stack); const btn=document.createElement('button'); btn.textContent='OK'; btn.onclick=function(){ pk.style.display='none'; resolve(); }; pk.append(btn); pk.style.display='flex'; }); }
function showRevealChoicePicker(rank, fuQty, hQty){ return new Promise(function(resolve){ const pk=document.getElementById('picker'); pk.innerHTML=''; const title=document.createElement('div'); title.className='row'; const b=document.createElement('b'); b.textContent='Play '+rank+'? Choose extras:'; title.append(b); pk.append(title);
  var includeFU = fuQty>0; var includeHand = hQty>0; var max = 1 + (includeFU?fuQty:0) + (includeHand?hQty:0);
  const toggles=document.createElement('div'); toggles.className='row';
  if(fuQty>0){ const cb=document.createElement('input'); cb.type='checkbox'; cb.checked=true; const lb=document.createElement('label'); lb.textContent='Include face-up ('+fuQty+')'; cb.onchange=function(){ includeFU=cb.checked; rebuildCounts(); }; toggles.append(cb,lb); }
  if(hQty>0){ const cbh=document.createElement('input'); cbh.type='checkbox'; cbh.checked=true; const lbh=document.createElement('label'); lbh.textContent='Include hand ('+hQty+')'; cbh.onchange=function(){ includeHand=cbh.checked; rebuildCounts(); }; toggles.append(cbh,lbh); }
  pk.append(toggles);
  const countRow=document.createElement('div'); countRow.className='row'; const choices=document.createElement('div'); choices.className='choices'; countRow.append(choices); pk.append(countRow);
  function rebuildCounts(){ max = 1 + (includeFU?fuQty:0) + (includeHand?hQty:0); renderButtons(); }
  function renderButtons(){ choices.innerHTML=''; for(let i=1;i<=max;i++){ const bt=document.createElement('button'); bt.textContent=String(i); bt.onclick=function(){ pk.style.display='none'; resolve({useFU:includeFU, useHand:includeHand, count:i}); }; choices.append(bt); } }
  renderButtons();
  const cancel=document.createElement('button'); cancel.textContent='Cancel'; cancel.onclick=function(){ pk.style.display='none'; resolve(null); }; pk.append(cancel);
  pk.style.display='flex'; }); }

// ===== Human interactions (picker) =====
function promptCountAndPlay(rank, source, max){
  if(!state.roundActive || state.uiLock) return;

  const current = state.players[state.turn];
  if(!current || !current.isHuman) return;

  if(source==='faceUp' && countFaceUpRank(current, rank)===0) return;

  // 10 always plays exactly 1 immediately
  if(rank==='10'){
    playCards(current, rank, source, 1, false, false);
    return;
  }

  const fuQty = countFaceUpRank(current, rank);
  const hQty  = countHandRank(current, rank);

  // Auto-play all copies (except A, 2, 10)
  if (settings.autoPlayCopies && !['A','2','10'].includes(rank)) {
    const total = fuQty + hQty;
    if (total >= 1) {
      playCards(current, rank, source, total, fuQty>0, hQty>0);
      return;
    }
  }

  // If only 1 available with no extras elsewhere, just play 1
  if (max === 1){
    const extrasElsewhere = (source==='hand') ? (fuQty>0) : (hQty>0);
    if(!extrasElsewhere){
      playCards(current, rank, source, 1, false, false);
      return;
    }
  }

  // Otherwise show the picker
  showPicker(rank, source, max);
}

function showPicker(rank, source, max) {
  const autoPlay = !!settings.autoPlayCopies;
  const pk = document.getElementById('picker');
  pk.innerHTML = '';
  const p = state.players[state.turn];

  var includeFU = false, includeHand = false;
  var countCap = max;
  var capNote = null;
  var buttons = null;

  // Determine additional counts from other zone
  if (source === 'hand') {
    const fuQty = countFaceUpRank(p, rank);
    if (fuQty > 0) {
      includeFU = true;
      countCap = max + fuQty;
      const row = document.createElement('div');
      row.className = 'row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.id = 'incfu';
      const lb = document.createElement('label');
      lb.setAttribute('for', 'incfu');
      lb.textContent = 'Include face-up (' + fuQty + ' available)';
      cb.onchange = function () {
        includeFU = cb.checked;
        countCap = includeFU ? (max + fuQty) : max;
        if (capNote) capNote.textContent = 'Max: ' + countCap;
        rebuildButtons();
      };
      row.append(cb, lb);
      pk.append(row);
      capNote = document.createElement('span');
      capNote.style.opacity = '.8';
      capNote.style.margin = '0 8px';
      capNote.textContent = 'Max: ' + countCap;
      pk.append(capNote);
    }
  } else if (source === 'faceUp') {
    const hQty = countHandRank(p, rank);
    if (hQty > 0) {
      includeHand = true;
      countCap = max + hQty;
      const row = document.createElement('div');
      row.className = 'row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.id = 'inchand';
      const lb = document.createElement('label');
      lb.setAttribute('for', 'inchand');
      lb.textContent = 'Include hand (' + hQty + ' available)';
      cb.onchange = function () {
        includeHand = cb.checked;
        countCap = includeHand ? (max + hQty) : max;
        if (capNote) capNote.textContent = 'Max: ' + countCap;
        rebuildButtons();
      };
      row.append(cb, lb);
      pk.append(row);
      capNote = document.createElement('span');
      capNote.style.opacity = '.8';
      capNote.style.margin = '0 8px';
      capNote.textContent = 'Max: ' + countCap;
      pk.append(capNote);
    }
  }

  // Build normal picker UI
  const title = document.createElement('div');
  title.className = 'row';
  const b = document.createElement('b');
  b.textContent = 'Play ' + rank + ' — choose count:';
  title.append(b);
  pk.append(title);

  function rebuildButtons() {
    if (!buttons) {
      buttons = document.createElement('div');
      buttons.className = 'row';
      pk.append(buttons);
    }
    buttons.innerHTML = '';
    for (let i = 1; i <= countCap; i++) {
      const btn = document.createElement('button');
      btn.textContent = String(i);
      btn.onclick = function () {
        pk.style.display = 'none';
        playCards(state.players[state.turn], rank, source, i, includeFU, includeHand);
      };
      buttons.append(btn);
    }
  }

  rebuildButtons();

  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  cancel.onclick = function () { pk.style.display = 'none'; };
  pk.append(cancel);

  pk.style.display = 'flex';
}

// ===== Play Logic =====
async function playCards(player,rank,source,count,includeFU,includeHand){ includeFU=!!includeFU; includeHand=!!includeHand; const isTen=(rank==='10'); const rv=RVAL[rank]; const prevLabel=labelActive();
  if(!isTen && state.currentValue!==null && rv>state.currentValue){
    const pileBefore=state.pile.slice(); const attempted=Array.from({length:count},function(){return {r:rank,s:'♠'};});
    logAction(player.name+' overplays with '+rank+'×'+count+' (was '+prevLabel+'); picks up.',{snapshotCards:[].concat(pileBefore,attempted)});
    await maybePauseBefore('pickup',[].concat(pileBefore,attempted),player.name);
    if(state.pile.length){ player.hand.push.apply(player.hand,state.pile.filter(Boolean)); }
    if(source==='faceUp'){ const moved=removeFaceUpOfRank(player,rank,count); if(moved.length) player.hand.push.apply(player.hand,moved); }
    state.pile = [];
    state.currentValue=null; state.currentCount=0; incPickup(player); render(); await sleep(200); return player.isHuman? enableHumanChoices(): aiTakeTurn(player,true);
  }
  let played=[]; if(source==='hand'){ let moved=0; const rest=[]; for(const c of player.hand){ if(c && moved<count && c.r===rank){ played.push(c); moved++; } else rest.push(c); } player.hand=rest; if(includeFU && moved<count){ const need=count-moved; const extra=removeFaceUpOfRank(player,rank,need); played.push.apply(played,extra); } }
  else if(source==='faceUp'){ const removed=removeFaceUpOfRank(player,rank,count); played.push.apply(played,removed); if(includeHand && removed.length<count){ const need=count-removed.length; let moved=0; const rest=[]; for(const c of player.hand){ if(c && moved<need && c.r===rank){ played.push(c); moved++; } else rest.push(c); } player.hand=rest; } }
  else if(source==='faceDownReveal'){ /* handled elsewhere */ }
  if(isTen){ logAction(player.name+' plays '+rank+' from '+source+'; was '+prevLabel+' → clear.',{snapshotCards:[].concat(state.pile.slice(),played)}); }
  else { logAction(player.name+' plays '+rank+'×'+played.length+' from '+source+(includeFU?'+face-up':'')+(includeHand?'+hand':'')+'; was '+prevLabel+'.',{snapshotCards:[].concat(state.pile.slice(),played)}); }
  state.pile.push.apply(state.pile,played);
  if(isTen){ const snap=state.pile.slice(); await maybePauseBefore('clear',snap,player.name); await clearPile(player,'10'); if(hasCards(player)) { await sleep(180); return player.isHuman? enableHumanChoices(): aiTakeTurn(player,true); } }
  else { if(state.currentValue===rv) state.currentCount+=played.length; else { state.currentValue=rv; state.currentCount=played.length; } if(state.currentCount>=4){ const snap2=state.pile.slice(); await maybePauseBefore('clear',snap2,player.name); await clearPile(player,rank+' reached '+state.currentCount); if(hasCards(player)) { await sleep(180); return player.isHuman? enableHumanChoices(): aiTakeTurn(player,true); } } }
  maybeDeclare(player); logBoardState(); endOrNext(); }

function maybeDeclare(p){
  const remaining = p.hand.filter(Boolean).length + faceUpCards(p).length + faceDownCount(p);

  // Track "one card" declaration once per player
  if (remaining === 1 && !state.mustDeclare.has(p.id)) {
    state.mustDeclare.add(p.id);
    toast(p.name + ': "One card!"');
    log(p.name + ' declares: one card');
  }

  // --- AI should never block: use non-blocking toasts instead of blocking modals ---
  if (!p.isHuman && remaining === 1) {
    toast(p.name + ' has one card left.');
  }

  // Optional AI low-card warnings (Settings -> warnOn), also non-blocking
  if (settings.warnOn && !p.isHuman) {
    const key = p.id;
    const prev = (state.warnedAt.get(key) || Infinity);

    if (remaining <= settings.warnThresh && remaining > 0 && remaining < prev) {
      toast(p.name + ' has ' + remaining + ' cards left.');
      state.warnedAt.set(key, remaining);
    }

    if (remaining > settings.warnThresh) {
      state.warnedAt.delete(key);
    }
  }
}

function hasCards(p){ return p.hand.filter(Boolean).length + faceUpCards(p).length + faceDownCount(p) > 0; }

// ===== Modals =====
function modalBase(msg,blocking){ if(blocking===undefined) blocking=true; const pk=document.getElementById('picker'); pk.innerHTML=''; const row=document.createElement('div'); row.className='row'; const b=document.createElement('b'); b.textContent=msg; row.append(b); pk.append(row); const ok=document.createElement('button'); ok.textContent='OK'; ok.onclick=function(){ pk.style.display='none'; }; pk.append(ok); pk.style.display='flex'; if(!blocking){ setTimeout(function(){ if(pk.style.display==='flex') pk.style.display='none'; },1400); } }
function showBlockingModal(msg){ modalBase(msg,true); }

// ===== Face-down flip =====
async function tryFlipFaceDownSlot(slotIdx){
  const p = state.players[state.turn];
  const s = p.slots[slotIdx];
  if(!s || s.up || !s.down) return;

  const c = s.down;         // the blind card
  s.down = null;
  if(!c){ render(); return; }

  const rv = RVAL[c.r];
  const prevLabel = labelActive();
  const isHuman = !!p.isHuman;

  if(isHuman) state.uiLock = true;  // lock input during forced reveal+play

  try{
    if(isHuman){
      await showRevealModal(c);     // user acknowledges the flipped card
    }

    // Overplay on blind flip (not a 10): forced pickup, same player continues
    if(state.currentValue !== null && rv > state.currentValue && c.r !== '10'){
      const pileBefore = state.pile.slice();
      const show = pileBefore.concat([c]);
      logAction(p.name+' flips '+c.r+' over '+prevLabel+'; picks up.', {snapshotCards:show});
      await maybePauseBefore('pickup', show, p.name);

      if(state.pile.length){
        p.hand.push.apply(p.hand, state.pile.filter(Boolean));
      }
      state.pile = [];
      p.hand.push(c);
      state.currentValue = null;
      state.currentCount = 0;
      incPickup(p);
      render();
      logBoardState();
      await sleep(80);
      return isHuman ? enableHumanChoices() : aiTakeTurn(p, true);
    }

    // Otherwise, the flipped card is immediately played
    logAction(p.name+' flips '+c.r+(isHuman?'':' (AI)')+'; was '+prevLabel+'.',
              {snapshotCards:[].concat(state.pile.slice(),[c])});
    state.pile.push(c);

    // Blind 10 clears → same player must continue
    if(c.r === '10'){
      const snap = state.pile.slice();
      await maybePauseBefore('clear', snap, p.name);
      await clearPile(p, '10 (blind)');
      if(hasCards(p)){
        await sleep(160);
        return isHuman ? enableHumanChoices() : aiTakeTurn(p, true);
      }
    } else {
      // Update active value/count
      if(state.currentValue === null){ state.currentValue = rv; state.currentCount = 1; }
      else if(rv === state.currentValue){ state.currentCount += 1; }
      else { state.currentValue = rv; state.currentCount = 1; }

            // Human may add same-rank extras
      if (isHuman){
        const special = (c.r==='A' || c.r==='2' || c.r==='10');
        const fuQty = countFaceUpRank(p, c.r);
        const hQty  = countHandRank(p, c.r);

        if (settings.autoPlayCopies && !special){
          // Auto: add ALL available from face-up and hand
          if (fuQty > 0){
            const extraFU = removeFaceUpOfRank(p, c.r, fuQty);
            state.pile.push(...extraFU);
            state.currentCount += extraFU.length;
          }
          if (hQty > 0){
            let moved = 0, rest = [];
            for (const x of p.hand){
              if (x && x.r === c.r){ state.pile.push(x); moved++; }
              else rest.push(x);
            }
            p.hand = rest;
            state.currentCount += moved;
          }
        } else if (fuQty > 0 || hQty > 0){
          // Manual picker (existing UX)
          const choice = await showRevealChoicePicker(c.r, fuQty, hQty);
          if(choice){
            let toAdd = choice.count - 1;

            if(choice.useFU && fuQty > 0){
              const takeFU = Math.min(fuQty, toAdd);
              const extraFU = removeFaceUpOfRank(p, c.r, takeFU);
              state.pile.push(...extraFU);
              state.currentCount += extraFU.length;
              toAdd -= extraFU.length;
            }

            if(choice.useHand && hQty > 0 && toAdd > 0){
              let moved = 0, rest = [];
              for(const x of p.hand){
                if(x && moved < toAdd && x.r === c.r){ state.pile.push(x); moved++; }
                else rest.push(x);
              }
              p.hand = rest;
              state.currentCount += moved;
            }
          }
        }
      } else {
        // AI auto-adds all same-rank extras
        const canFU = removeFaceUpOfRank(p, c.r, 99);
        if(canFU.length){ state.pile.push(...canFU); state.currentCount += canFU.length; }
        let addH = [], rest = [];
        for(const x of p.hand){ if(x && x.r === c.r) addH.push(x); else rest.push(x); }
        p.hand = rest;
        if(addH.length){ state.pile.push(...addH); state.currentCount += addH.length; }
      }

      // Four-or-more clears → same player must continue
      if(state.currentCount >= 4){
        const snap2 = state.pile.slice();
        await maybePauseBefore('clear', snap2, p.name);
        await clearPile(p, c.r+' reached '+state.currentCount);
        if(hasCards(p)){
          await sleep(160);
          return isHuman ? enableHumanChoices() : aiTakeTurn(p, true);
        }
      }
    }

    maybeDeclare(p);
    logBoardState();
    endOrNext();
  } finally {
    if(isHuman) state.uiLock = false;  // always release the lock for humans
  }
}

// ===== Clear / Turn =====
async function clearPile(byPlayer,reason){ if(state.pile.length){ const pileBefore=state.pile.slice(); logAction(byPlayer.name+' clears the pile ('+reason+').',{snapshotCards:pileBefore}); state.pile.length=0; } state.currentValue=null; state.currentCount=0; render(); logBoardState(); await sleep(200); }
function endOrNext(){ render(); const finisher=state.players.find(function(pp){return !hasCards(pp);}); if(finisher){ scoreRound(finisher); return; } state.turn=(state.turn+1)%state.players.length; render(); const cur=state.players[state.turn]; if(!cur.isHuman) aiTakeTurn(cur); }

// ===== AI =====
function getSelectedDifficulty(){ const el=document.getElementById('aiDifficulty'); return el? (el.value||'easy') : 'easy'; }
function getAIDifficulty(){ const sel=getSelectedDifficulty(); if(sel==='adaptive') return state.aiAdaptive; return sel; }
function displayDiffLabel(){ const sel=getSelectedDifficulty(); return sel==='adaptive' ? ('Adaptive ('+state.aiAdaptive+')') : sel; }
function rem(p){ return p.hand.filter(Boolean).length + faceUpCards(p).length + faceDownCount(p); }
function everyoneEarly(){ return state.players.every(function(pl){ return faceUpCards(pl).length===4 && faceDownCount(pl)===4 && pl.hand.filter(Boolean).length>=4; }); }
function pileCounts(){ const m={}; for(const c of state.pile){ if(!c) continue; m[c.r]=(m[c.r]||0)+1; } return m; }
function totalByRanks(m,ranks){ let s=0; for(const r of ranks){ s+=m[r]||0; } return s; }
function aiLog(p,msg){ log(p.name+' ['+displayDiffLabel()+']: '+msg); }
function pointsOf(cards){ return cards.reduce(function(acc,c){return acc+scoringValue(c.r);},0); }
function maxUnloadGroupPoints(p){ const fu=faceUpCards(p), hand=p.hand; const groups={}; [...fu,...hand].forEach(function(c){ if(!c) return; if(c.r==='10'||c.r==='A') return; (groups[c.r]||(groups[c.r]=[])).push(c); }); let best=0; Object.values(groups).forEach(function(g){ best=Math.max(best, pointsOf(g)); }); return best; }
function pilePointsAdjustedForGuaranteedClear(p){ const counts=pileCounts(); let pts=pointsOf(state.pile); for(const r in counts){ const have = countHandRank(p,r)+countFaceUpRank(p,r); if(r!=='A' && counts[r]+have>=4){ const rPts = counts[r]*scoringValue(r); pts -= rPts; } } return Math.max(0,pts); }
async function aiTakeTurn(p, chain){
  if(chain === undefined) chain = false;

  try{
    if(!state.roundActive) { endOrNext(); return; }

    await sleep(chain ? 180 : 420);

    const fu = faceUpCards(p);
    const diff = getAIDifficulty();
    const pileLen = state.pile.length;

    // ===== “hard/expert” early-pressure branches (unchanged logic) =====
    if((diff==='hard'||diff==='expert') && state.currentValue!==null){
      const counts=pileCounts(); const distinct=Object.keys(counts).length;
      const onlyAces = distinct===1 && counts['A']>0;
      const single3 = distinct===1 && counts['3']===1;
      const few2s = distinct===1 && counts['2']>=1 && counts['2']<=3;

      if(onlyAces){
        const higherFU = [...new Set(fu.map(c=>c.r))].filter(r => RVAL[r]>1);
        if(higherFU.length) return playCards(p, higherFU[0], 'faceUp', 1);

        const idx1 = p.slots.findIndex(s => s && !s.up && s.down); // ✅ use p.slots
        if(idx1>=0) return tryFlipFaceDownSlot(idx1);

        const higherH = [...new Set(p.hand.map(c=>c&&c.r))].filter(r => r && RVAL[r]>1);
        if(higherH.length) return playCards(p, higherH[0], 'hand', 1);
      }

      if(single3 || few2s){
        const higherFU2 = [...new Set(fu.map(c=>c.r))].filter(r => RVAL[r] > state.currentValue);
        if(higherFU2.length) return playCards(p, higherFU2[0], 'faceUp', 1);

        const higherH2 = [...new Set(p.hand.map(c=>c&&c.r))].filter(r => r && RVAL[r] > state.currentValue);
        if(higherH2.length) return playCards(p, higherH2[0], 'hand', 1);

        const j = p.slots.findIndex(s => s && !s.up && s.down); // ✅ use p.slots
        if(j>=0) return tryFlipFaceDownSlot(j);
      }

      if(diff==='expert'){
        const counts3=pileCounts(); const distinct3=Object.keys(counts3).length;
        if(distinct3<3){
          const pilePts = pilePointsAdjustedForGuaranteedClear(p);
          const unload  = maxUnloadGroupPoints(p);
          if(unload > pilePts){
            const higherFU3 = [...new Set(fu.map(c=>c.r))].filter(r => RVAL[r] > state.currentValue);
            if(higherFU3.length) return playCards(p, higherFU3[0], 'faceUp', 1);

            const higherH3 = [...new Set(p.hand.map(c=>c&&c.r))].filter(r => r && RVAL[r] > state.currentValue);
            if(higherH3.length) return playCards(p, higherH3[0], 'hand', 1);

            const k = p.slots.findIndex(s => s && !s.up && s.down); // ✅ use p.slots
            if(k>=0) return tryFlipFaceDownSlot(k);
          }
        }
      }
    }

    // ===== General play logic (unchanged behavior) =====
    const ranksAvail=new Set(); p.hand.forEach(c=>{ if(c&&c.r) ranksAvail.add(c.r); }); fu.forEach(c=>ranksAvail.add(c.r));
    let legal=[...ranksAvail].filter(r=>canPlayRank(r)); const nonAce=legal.filter(r=>r!=='A'); if(nonAce.length) legal=nonAce;

    const oppClose= state.players.some(pl=> pl.id!==p.id && rem(pl) <= 6);
    const early=everyoneEarly();

    const canClearNow=function(r){
      const qty=p.hand.filter(c=>c&&c.r===r).length + fu.filter(c=>c.r===r).length +
        ((state.currentValue!==null && RANKS[state.currentValue-1]===r)? state.currentCount : 0);
      return qty>=4;
    };
    const considerClear=function(r){
      if(diff==='hard'||diff==='expert'){
        if(oppClose && !early){
          const unloadPts = maxUnloadGroupPoints(p);
          if(unloadPts < 15) return false;
        }
      }
      return true;
    };

    for(const r of legal){ if(r==='10') continue; if(canClearNow(r) && considerClear(r)){
      const cntFU=fu.filter(c=>c.r===r).length;
      if(cntFU) return playCards(p,r,'faceUp',cntFU);
      const cntH=p.hand.filter(c=>c&&c.r===r).length;
      if(cntH) return playCards(p,r,'hand',cntH);
    }}

    const hasTenHand=p.hand.some(c=>c&&c.r==='10'); const hasTenFU=fu.some(c=>c.r==='10');
    if(hasTenHand||hasTenFU){
      let use10=false;
      if(diff==='easy') use10 = oppClose || pileLen>6 || Math.random()<0.6;
      else if(diff==='medium') use10 = oppClose || pileLen>=10 || early;
      else {
        const unloadPts = maxUnloadGroupPoints(p);
        use10 = (!state.currentValue || pileLen>=12 || early) && (oppClose ? unloadPts>=15 : true);
      }
      if(use10){ if(hasTenHand) return playCards(p,'10','hand',1); else return playCards(p,'10','faceUp',1); }
    }

    const legalFU=[...new Set(fu.map(c=>c.r))].filter(r=>canPlayRank(r) && r!=='A');
    if(legalFU.length){ legalFU.sort((a,b)=>RVAL[b]-RVAL[a]); const r1=legalFU[0]; const cnt=fu.filter(c=>c.r===r1).length; return playCards(p,r1,'faceUp',cnt); }
    legal.sort((a,b)=>RVAL[b]-RVAL[a]);
    for(const r2 of legal){ if(r2==='A') continue; const cntH2=p.hand.filter(c=>c&&c.r===r2).length; if(cntH2){ return playCards(p,r2,'hand',cntH2); } }

    if(ranksAvail.has('A') && canPlayRank('A')){
      if(fu.some(c=>c.r==='A')) return playCards(p,'A','faceUp',1);
      if(p.hand.some(c=>c&&c.r==='A')) return playCards(p,'A','hand',1);
    }

    if(state.currentValue!==null){
      const higherFU=[...new Set(fu.map(c=>c.r))].filter(r=>RVAL[r]>state.currentValue);
      if(higherFU.length) return playCards(p,higherFU[0],'faceUp',1);
      const higherH=[...new Set(p.hand.map(c=>c&&c.r))].filter(r=>r && RVAL[r]>state.currentValue);
      if(higherH.length) return playCards(p,higherH[0],'hand',1);
    }

    // ✅ If nothing else, *flip on this player*, using p.slots (not state.players[state.turn])
    const i = p.slots.findIndex(s => s && !s.up && s.down);
    if(i>=0){ return tryFlipFaceDownSlot(i); }

    endOrNext();
  }catch(err){
    log('AI turn error for ' + p.name + ': ' + (err && err.message ? err.message : String(err)));
    // Try to keep the game flowing
    endOrNext();
  }
}

// ===== Scoring / Rounds =====
async function scoreRound(finisher){
  state.roundActive=false;

  // Tally this round’s points into match scores
  const pts = state.players.map(function(p){
    let s=0;
    p.hand.forEach(function(c){ if(!c) return; s+=scoringValue(c.r); });
    faceUpCards(p).forEach(function(c){ s+=scoringValue(c.r); });
    p.slots.forEach(function(sl){ if(sl&&sl.down) s+=scoringValue(sl.down.r); });
    return s;
  });

  // Record this round's points for stats (NEW)
  state.roundHistory.push(pts.slice());

  // Add to match totals
  pts.forEach(function(s,i){ state.players[i].score += s; });

  log('Round ended. '+finisher.name+' went out. Scoring applied.');
  updateScores();

  // Show the round modal (and possibly final scores)
  await showEndOfRoundModal(finisher, pts);

  const over = state.players.find(function(pp){ return pp.score >= 150; });
  if(over){
    state.matchActive = false;
    const sorted = [...state.players].sort((a,b)=>a.score - b.score);
    const winner = sorted[0];
    const winnerIsYou = winner.isHuman || /^you$/i.test(winner.name);
    const toastText = winnerIsYou ? 'Match Over! Winner: You' : ('Match Over! Winner: '+winner.name);
    toast(toastText);
    document.getElementById('status').textContent = winnerIsYou ? 'Match Over — Winner: You' : ('Match Over — Winner: ' + winner.name);

    // Enable the Start New Game button in controls
    const btn=document.getElementById('newRound');
    btn.disabled=false;
    btn.title='';
    render();
    return;
  }

  // Prepare next round automatically (unchanged)
  if(getSelectedDifficulty()==='adaptive'){
    const meScore = state.players[0].score; const minScore = Math.min.apply(null,state.players.map(function(p){return p.score;}));
    const ladder=['easy','medium','hard','expert']; let idx=ladder.indexOf(state.aiAdaptive); if(idx<0) idx=1;
    if(meScore===minScore && idx<ladder.length-1) idx++; else if(meScore>minScore && idx>0) idx--; state.aiAdaptive = ladder[idx];
    log('AI difficulty (Adaptive) adjusted to: '+state.aiAdaptive);
  }

  nextDealer();
  dealRound();
  document.getElementById('status').textContent='New round. '+state.players[state.turn].name+' to play.';
  log('New round begins. Dealer: '+state.players[state.dealer].name+'. '+state.players[state.turn].name+' starts.');
  render();
  if(!state.players[state.turn].isHuman) aiTakeTurn(state.players[state.turn]);
}

function updateScores(){ const wrap=document.getElementById('scores'); wrap.innerHTML=''; state.players.forEach(function(p){ const d=document.createElement('div'); d.className='slot'; d.textContent=p.name+': '+p.score; wrap.append(d); }); }
function forfeitMatch(){ if(!state.roundActive && !state.matchActive) return; state.roundActive=false; state.matchActive=false; document.getElementById('status').textContent='You forfeited. Match ended.'; log('You forfeited. Match ended.'); const btn=document.getElementById('newRound'); btn.disabled=false; btn.title=''; render(); }

function showEndOfRoundModal(finisher, roundPoints){
  return new Promise(function(resolve){
    const modal = document.getElementById('roundModal');
    const body  = document.getElementById('roundBody');
    const title = document.getElementById('roundTitle');
    const okBtn = document.getElementById('roundOk');
    const startNewBtn = document.getElementById('roundStartNew');
    const viewBoardBtn = document.getElementById('roundViewBoard');
    const finalScoresBox = document.getElementById('finalScores');
    const actions = document.getElementById('roundActions');

    body.innerHTML = '';
    finalScoresBox.innerHTML = '';
    finalScoresBox.style.display = 'none';

    // Build accordion of end-of-round hands (unchanged)
    let maxP=-1, minP=Infinity;
    state.players.forEach(function(p){ const v=(state.roundStats.pickups.get(p.id)||0); maxP=Math.max(maxP,v); minP=Math.min(minP,v); });

    const acc=document.createElement('div'); acc.className='accordion';
    state.players.forEach(function(p,idx){
      const item=document.createElement('div'); item.className='item';
      const head = document.createElement('h4');
      head.className = 'roundHead'; // grid/flex header
      const pts = roundPoints[idx];

      const nameEl = document.createElement('span');
      nameEl.className = 'rh-name';
      nameEl.textContent = p.name;

      const ptsEl = document.createElement('span');
      ptsEl.className = 'rh-pts';
      ptsEl.innerHTML = `<b>${pts}</b> pts`;

      head.append(nameEl, ptsEl);
      item.append(head);


      const bodyRow=document.createElement('div'); bodyRow.style.display='none';
      const sec=function(label,cards){
        const wrap=document.createElement('div');
        const h=document.createElement('div'); h.textContent=label; h.style.margin='6px 0'; wrap.append(h);
        const st=document.createElement('div'); st.className='stack'; cards.forEach(function(c){ st.append(makeCardEl(c,true,false)); }); wrap.append(st);
        bodyRow.append(wrap);
      };
      const hand=p.hand.slice(); const fu=faceUpCards(p); const fd=p.slots.map(function(s){return s&&s.down;}).filter(Boolean);
      if(idx===0){ bodyRow.style.display='block'; }
      sec('Hand',hand); sec('Face-up',fu); sec('Face-down',fd);

      head.addEventListener('click',function(){ bodyRow.style.display = bodyRow.style.display==='none' ? 'block' : 'none'; });
      item.append(bodyRow);
      acc.append(item);
    });
    body.append(acc);

    const matchOver = state.players.some(function(p){return p.score>=150;});
    if(matchOver){
      // Winner is lowest score
      const sorted = [...state.players].map(p => ({name:p.name, score:p.score, isHuman:!!p.isHuman}))
        .sort((a,b)=>a.score - b.score);
      const winner = sorted[0];

      // Title grammar: "You win!" vs "<Name> wins!"
      const winnerText = winner.isHuman || /^you$/i.test(winner.name) ? 'You win!' : (winner.name + ' wins!');
      title.textContent = 'Match Over! ' + winnerText;

      const podium = document.createElement('div');
      podium.className = 'podium';

      sorted.forEach((p, idx) => {
        const entry = document.createElement('div');
        entry.className = 'podium-entry';

        const medal = idx===0 ? '🥇' : idx===1 ? '🥈' : idx===2 ? '🥉' : '🏅';
        const place = (idx===0?'1st':idx===1?'2nd':idx===2?'3rd':(idx+1)+'th');

        entry.innerHTML = `
          <div class="podium-medal" title="${place}">${medal}</div>
          <div class="podium-name">${p.name}</div>
          <div class="podium-score">${p.score}</div>
        `;
        podium.append(entry);
      });

      finalScoresBox.append(podium);
      finalScoresBox.style.display = 'block';


      // Buttons: Start New Game + View Board
      okBtn.style.display = 'none';
      startNewBtn.style.display = '';
      viewBoardBtn.style.display = '';

      // NEW: View Stats button
      let statsBtn = document.getElementById('roundViewStats');
      if(!statsBtn){
        statsBtn = document.createElement('button');
        statsBtn.id = 'roundViewStats';
        statsBtn.textContent = 'View Stats';
        actions.insertBefore(statsBtn, startNewBtn); // before Start New Game
      }else{
        statsBtn.style.display = '';
      }

      startNewBtn.onclick = function(){
        modal.style.display = 'none';
        // Start a brand new game with current player count
        startNewRound();
        resolve();
      };
      viewBoardBtn.onclick = function(){
        modal.style.display = 'none';
        resolve();
      };
      statsBtn.onclick = function(){
        openStatsModal();
      };
    } else {
      // Ongoing match: normal next-round button
      title.textContent = 'Round complete! ' + finisher.name + ' went out!';
      okBtn.textContent = 'Start Next Round';
      okBtn.style.display = '';
      startNewBtn.style.display = 'none';
      viewBoardBtn.style.display = 'none';

      // Hide stats button if it exists
      const statsBtn = document.getElementById('roundViewStats');
      if(statsBtn) statsBtn.style.display = 'none';

      okBtn.onclick = function(){
        modal.style.display = 'none';
        resolve();
      };
    }

    modal.style.display='flex';
  });
}

function openStatsModal(){
  const modal = document.getElementById('statsModal');
  const sel   = document.getElementById('statsPlayer');
  const chart = document.getElementById('statsChart');

  // Build player list
  sel.innerHTML = '';
  state.players.forEach((p, idx)=>{
    const opt = document.createElement('option');
    opt.value = String(idx);
    opt.textContent = p.name;
    sel.appendChild(opt);
  });

  function drawFor(playerIndex){
    const series = state.roundHistory.map(r => r[playerIndex] || 0);
    renderLineChart(chart, series);
  }

  sel.onchange = ()=> drawFor(parseInt(sel.value,10));

  // default to "You" if present, else first
  sel.value = '0';
  drawFor(0);

    // Totals area for pickups
  let totalsBox = document.getElementById('statsTotals');
  if(!totalsBox){
    totalsBox = document.createElement('div');
    totalsBox.id = 'statsTotals';
    totalsBox.style.marginTop = '10px';
    totalsBox.className = 'stats-totals';
    chart.parentElement.appendChild(totalsBox);
  }
  renderPickupTotals(totalsBox);


  modal.style.display = 'flex';

  document.getElementById('statsClose').onclick = ()=>{ modal.style.display='none'; };
  document.querySelector('#statsModal .backdrop').onclick = ()=>{ modal.style.display='none'; };
}

// Simple SVG line chart: y = points that round
function renderLineChart(container, values){
  const w = container.clientWidth || 520;
  const h = 220;
  const pad = {l:30, r:10, t:10, b:22};

  const n = Math.max(1, values.length);
  const maxY = Math.max(10, ...values);
  const x = i => pad.l + (n<=1 ? 0 : (i/(n-1)))*(w - pad.l - pad.r);
  const y = v => h - pad.b - (v/maxY)*(h - pad.t - pad.b);

  const pts = values.map((v,i)=>`${x(i)},${y(v)}`).join(' ');
  const ticks = 4;
  const yTicks = Array.from({length:ticks+1}, (_,i)=> Math.round((i*maxY)/ticks));

  const svg = `
  <svg viewBox="0 0 ${w} ${h}">
    <g class="axis">
      <line x1="${pad.l}" y1="${h-pad.b}" x2="${w-pad.r}" y2="${h-pad.b}" stroke="currentColor" />
      <line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${h-pad.b}" stroke="currentColor" />
      ${yTicks.map(t => {
        const yy = y(t);
        return `<text x="${pad.l-6}" y="${yy+4}" text-anchor="end">${t}</text>`;
      }).join('')}
    </g>
    <polyline fill="none" stroke="currentColor" stroke-width="2" points="${pts}"></polyline>
    ${values.map((v,i)=>`<circle cx="${x(i)}" cy="${y(v)}" r="3" fill="currentColor"></circle>`).join('')}
  </svg>`;
  container.innerHTML = svg;
}

function renderPickupTotals(container){
  const rows = state.players.map(p=>{
    const n = state.pickupsTotal.get(p.id) || 0;
    return `<div class="st-row"><span class="st-name">${p.name}</span><span class="st-val">${n}</span></div>`;
  }).join('');
  container.innerHTML = `<div class="st-title">Total pile pick-ups (match)</div>${rows}`;
}

// ===== Hint =====
// Return exactly what Expert AI would choose for the human (no side effects).
function computeExpertMove(p){
  const fu = faceUpCards(p);
  const pileLen = state.pile.length;

  const ranksFrom = (arr) => [...new Set(arr.map(c => c && c.r))].filter(Boolean);
  const playable = (r) => canPlayRank(r);
  const cntFU = (r) => fu.filter(c => c.r === r).length;
  const cntH  = (r) => p.hand.filter(c => c && c.r === r).length;

  const counts = pileCounts();
  const distinct = Object.keys(counts).length;
  const onlyAces = state.currentValue !== null && distinct===1 && counts['A']>0;
  const single3  = state.currentValue !== null && distinct===1 && counts['3']===1;
  const few2s    = state.currentValue !== null && distinct===1 && counts['2']>=1 && counts['2']<=3;

  const higherThan = (val) => ranksFrom(fu).filter(r => RVAL[r] > val)
                        .concat(ranksFrom(p.hand).filter(r => RVAL[r] > val))
                        .filter((r,i,a)=>a.indexOf(r)===i);

  const everyoneEarlyFlag = everyoneEarly();
  const oppClose = state.players.some(pl => pl.id !== p.id && rem(pl) <= 6);

  const qty = (r) => cntH(r) + cntFU(r);
  const canClearNow = (r) => {
    if(!playable(r)) return false;
    if(state.currentValue===null) return qty(r) >= 4;
    return (RANKS[state.currentValue-1]===r) && (qty(r) + state.currentCount >= 4);
  };
  const considerClear = (r) => {
    // expert logic mirrors aiTakeTurn
    if(oppClose && !everyoneEarlyFlag){
      const unloadPts = maxUnloadGroupPoints(p);
      if(unloadPts < 15) return false;
    }
    return true;
  };

  // ===== Expert-only early pressure branches (match aiTakeTurn) =====
  if(state.currentValue !== null){
    const cv = state.currentValue;

    if(onlyAces){
      // Try any higher-than-ace from table, else flip, else higher from hand
      const hiFU = ranksFrom(fu).filter(r => RVAL[r] > 1);
      if(hiFU.length) return {type:'play', source:'faceUp', rank:hiFU[0], count:1,
        reason:'Pile is all Aces; pushing above Ace forces the next player to pick up unless they can match.'};
      const idx1 = p.slots.findIndex(s => s && !s.up && s.down);
      if(idx1 >= 0) return {type:'flip', slot:idx1,
        reason:'No higher-than-Ace available face-up; flip to try revealing one or a 10.'};
      const hiH = ranksFrom(p.hand).filter(r => RVAL[r] > 1);
      if(hiH.length) return {type:'play', source:'hand', rank:hiH[0], count:1,
        reason:'Pile is all Aces; pushing above Ace from hand pressures opponents.'};
    }

    if(single3 || few2s){
      const hiFU2 = ranksFrom(fu).filter(r => RVAL[r] > cv);
      if(hiFU2.length) return {type:'play', source:'faceUp', rank:hiFU2[0], count:1,
        reason:'Raise above current value to break the opponent-friendly stack.'};
      const hiH2 = ranksFrom(p.hand).filter(r => RVAL[r] > cv);
      if(hiH2.length) return {type:'play', source:'hand', rank:hiH2[0], count:1,
        reason:'Raise above current value to disrupt the current build-up.'};
      const j = p.slots.findIndex(s => s && !s.up && s.down);
      if(j >= 0) return {type:'flip', slot:j,
        reason:'No safe raise available; flip for a potential clear or match.'};
    }

    if(distinct < 3){
      const pilePts = pilePointsAdjustedForGuaranteedClear(p);
      const unload  = maxUnloadGroupPoints(p);
      if(unload > pilePts){
        const hiFU3 = ranksFrom(fu).filter(r => RVAL[r] > cv);
        if(hiFU3.length) return {type:'play', source:'faceUp', rank:hiFU3[0], count:1,
          reason:'Unloading a stronger rank now is worth more than the pile value if picked up.'};
        const hiH3 = ranksFrom(p.hand).filter(r => RVAL[r] > cv);
        if(hiH3.length) return {type:'play', source:'hand', rank:hiH3[0], count:1,
          reason:'Value trade-off favors unloading from hand over potential pickup.'};
        const k = p.slots.findIndex(s => s && !s.up && s.down);
        if(k >= 0) return {type:'flip', slot:k,
          reason:'Look for a better option via a blind flip.'};
      }
    }
  }

  // ===== Clears with non-aces, prefer using face-up first =====
  const legalRanks = [...new Set(
    ranksFrom(p.hand).concat(ranksFrom(fu))
  )].filter(playable);

  for(const r of legalRanks.filter(r => r!=='10' && r!=='A')){
    if(canClearNow(r) && considerClear(r)){
      if(cntFU(r) > 0) return {type:'play', source:'faceUp', rank:r, count:cntFU(r),
        reason:'Reaching four-of-a-kind guarantees a clear; spend table copies first to keep hand flexible.'};
      if(cntH(r)  > 0) return {type:'play', source:'hand',  rank:r, count:cntH(r),
        reason:'Reaching four-of-a-kind guarantees a clear from hand.'};
    }
  }

  // ===== Consider 10 to clear =====
  const hasTenH  = cntH('10') > 0;
  const hasTenFU = cntFU('10') > 0;
  if(hasTenH || hasTenFU){
    const unload = maxUnloadGroupPoints(p);
    const shouldTen = (!state.currentValue || pileLen >= 12 || everyoneEarlyFlag) &&
                      (oppClose ? unload >= 15 : true);
    if(shouldTen){
      return {type:'play', source: hasTenH ? 'hand' : 'faceUp', rank:'10', count:1,
        reason: (!state.currentValue ? 'Fresh start—bank a safe clear.' :
                 `Pile has ${pileLen} cards—clearing denies value and improves tempo.`)};
    }
  }

  // ===== Prefer strongest playable from table (non-ace), dump all of that rank =====
  const playableFU = ranksFrom(fu).filter(r => playable(r) && r!=='A')
                                  .sort((a,b)=>RVAL[b]-RVAL[a]);
  if(playableFU.length){
    const r = playableFU[0];
    return {type:'play', source:'faceUp', rank:r, count:cntFU(r),
      reason:'Use table copies first; holding hand copies increases future combine/clear options.'};
  }

  // ===== Fallback to strongest playable from hand (non-ace), dump all of that rank =====
  const playableHand = ranksFrom(p.hand).filter(r => playable(r) && r!=='A')
                                        .sort((a,b)=>RVAL[b]-RVAL[a]);
  if(playableHand.length){
    const r = playableHand[0];
    return {type:'play', source:'hand', rank:r, count:cntH(r),
      reason:'Strongest legal non-ace from hand keeps pressure while staying under the cap.'};
  }

  // ===== Use Ace sparingly for tempo =====
  if(playable('A')){
    if(cntFU('A')>0) return {type:'play', source:'faceUp', rank:'A', count:1,
      reason:'Ace keeps options open while staying legal; table first to preserve hand.'};
    if(cntH('A')>0)  return {type:'play', source:'hand',  rank:'A', count:1,
      reason:'Ace maintains tempo with minimal commitment.'};
  }

  // ===== Try to climb above current with any higher card =====
  if(state.currentValue !== null){
    const hiFU = ranksFrom(fu).filter(r => RVAL[r] > state.currentValue);
    if(hiFU.length) return {type:'play', source:'faceUp', rank:hiFU[0], count:1,
      reason:'Raise above current value to shift control.'};
    const hiH  = ranksFrom(p.hand).filter(r => RVAL[r] > state.currentValue);
    if(hiH.length) return {type:'play', source:'hand', rank:hiH[0], count:1,
      reason:'Raise above current value from hand to change tempo.'};
  }

  // ===== Last resort: flip a face-down =====
  const i = p.slots.findIndex(s => s && !s.up && s.down);
  if(i >= 0) return {type:'flip', slot:i, reason:'No legal play—try a blind flip for a clear or match.'};

  return {type:'none', reason:'No action available.'};
}

function expertRecommendation(){
  const p = state.players[0]; // the human player
  const move = computeExpertMove(p);

  // Build a human-readable suggestion
  let suggestion;
  if(move.type === 'play'){
    const from = move.source === 'faceUp' ? 'table' : 'hand';
    const qtyTxt = move.count > 1 ? ` ×${move.count}` : '';
    suggestion = `Play ${move.rank}${qtyTxt} from ${from}.`;
  }else if(move.type === 'flip'){
    suggestion = 'Flip a face-down card.';
  }else{
    suggestion = 'No action.';
  }

  // Return HTML with spacing between suggestion and reasoning
  const reason = move.reason ? move.reason : '';
  return `<div><b>${suggestion}</b></div><div style="margin-top:6px;opacity:.92">Reason: ${reason}</div>`;
}

function openHint(){
  const m = document.getElementById('hintModal');
  const body = document.getElementById('hintBody');
  body.innerHTML = expertRecommendation();  // HTML so we can include spacing
  m.style.display = 'flex';
}

// ===== Floating mini pile =====
function placeMiniByCorner(corner){ const mini=document.getElementById('miniPile'); const anchor=document.getElementById('miniAnchor'); const pos={tl:[10,10], tr:[window.innerWidth-10-mini.offsetWidth,10], bl:[10,window.innerHeight-10-mini.offsetHeight], br:[window.innerWidth-10-mini.offsetWidth, window.innerHeight-10-mini.offsetHeight]}; const target=pos[corner]||pos.tr; const x=target[0]; const y=target[1]; mini.style.left=x+'px'; mini.style.top=y+'px'; mini.style.right='auto'; mini.style.bottom='auto'; const ax = corner.indexOf('l')>=0? 10 : (window.innerWidth-54); const ay = corner.indexOf('t')>=0? 10 : (window.innerHeight-54); anchor.style.left=ax+'px'; anchor.style.top=ay+'px'; }
function renderMiniPile(){ const mini=document.getElementById('miniPile'); const mInfo=document.getElementById('miniInfo'); const mMore=document.getElementById('miniMore'); const mStack=document.getElementById('miniStack'); mStack.innerHTML=''; state.pile.filter(Boolean).forEach(function(c){ mStack.append(makeCardEl(c,true,false)); }); mInfo.textContent= state.currentValue? (RANKS[state.currentValue-1]+' × '+state.currentCount) : 'Fresh start'; const overflow = mStack.scrollHeight > mini.clientHeight; mMore.textContent = overflow ? 'Scroll to see all' : ''; mini.scrollTop = mini.scrollHeight; placeMiniByCorner(settings.miniCorner||'tr'); const anchor=document.getElementById('miniAnchor'); if(settings.miniHidden){ mini.style.display='none'; anchor.style.display='flex'; }else{ anchor.style.display='none'; }
}
let miniObserverInitialized = false;
function initMiniObserver(){
  if (miniObserverInitialized) return;
  miniObserverInitialized = true;

  const target = document.getElementById('centerPile');
  const mini   = document.getElementById('miniPile');
  const anchor = document.getElementById('miniAnchor');
  if (!('IntersectionObserver' in window) || !target) return;

  const io = new IntersectionObserver(function(entries){
    const e = entries[0];
    const mobile = window.innerWidth <= 900;
    if (mobile && (!e.isIntersecting) && !settings.miniHidden) mini.style.display='block';
    else mini.style.display='none';
    anchor.style.display = (mobile && settings.miniHidden) ? 'flex' : 'none';
  },{root:null,threshold:0.1});
  io.observe(target);

  // Optional double-tap to hide/show
  let lastTap = 0;
  function onTap(e){
    if(!settings.miniTap) return;
    const now = Date.now();
    if (now - lastTap < 350) {
      settings.miniHidden = true;
      saveSettings();
      renderMiniPile();
      lastTap = 0;
    } else {
      lastTap = now;
    }
  }
  mini.addEventListener('click', onTap);
  anchor.addEventListener('click', function(){
    settings.miniHidden = false;
    saveSettings();
    const m = document.getElementById('miniPile');
    m.style.display = 'block';
    renderMiniPile();
  });

  // Drag with corner snap; if dragged harder into its current corner, hide it.
  let dragging=false, startX=0, startY=0, baseX=0, baseY=0;
  function onDown(e){
    dragging=true;
    const rect = mini.getBoundingClientRect();
    baseX=rect.left; baseY=rect.top;
    startX=(e.touches?e.touches[0].clientX:e.clientX);
    startY=(e.touches?e.touches[0].clientY:e.clientY);
    e.preventDefault();
  }
  function onMove(e){
    if(!dragging) return;
    const x=(e.touches?e.touches[0].clientX:e.clientX);
    const y=(e.touches?e.touches[0].clientY:e.clientY);
    const nx=baseX+(x-startX);
    const ny=baseY+(y-startY);
    mini.style.left=nx+'px';
    mini.style.top=ny+'px';
    mini.style.right='auto';
    mini.style.bottom='auto';
  }
  function onUp(){
    if(!dragging) return;
    dragging=false;

    const rect = mini.getBoundingClientRect();
    const cx = rect.left + rect.width/2;
    const cy = rect.top + rect.height/2;
    const corner = (cy < window.innerHeight/2 ? 't' : 'b') + (cx < window.innerWidth/2 ? 'l' : 'r');

    // If user pushes further into the *same* corner than before, hide it
    const thresh = 20;
    const sameCorner = corner === (settings.miniCorner || 'tr');
    const pushedDeeper =
      (corner === 'tr' && rect.top <= thresh && (window.innerWidth - rect.right) <= thresh) ||
      (corner === 'tl' && rect.top <= thresh && rect.left <= thresh) ||
      (corner === 'br' && (window.innerHeight - rect.bottom) <= thresh && (window.innerWidth - rect.right) <= thresh) ||
      (corner === 'bl' && (window.innerHeight - rect.bottom) <= thresh && rect.left <= thresh);

    if (sameCorner && pushedDeeper) {
      settings.miniHidden = true;
      saveSettings();
      renderMiniPile();
      return;
    }

    settings.miniCorner = corner;
    saveSettings();
    placeMiniByCorner(corner);
  }

  mini.addEventListener('mousedown', onDown);
  mini.addEventListener('touchstart', onDown, {passive:false});
  window.addEventListener('mousemove', onMove);
  window.addEventListener('touchmove', onMove, {passive:false});
  window.addEventListener('mouseup', onUp);
  window.addEventListener('touchend', onUp);
}

function incPickup(p){
  const m = state.roundStats && state.roundStats.pickups;
  if (m){
    const prev = m.get(p.id) || 0;
    m.set(p.id, prev + 1);
  }
  // cumulative
  const tot = state.pickupsTotal.get(p.id) || 0;
  state.pickupsTotal.set(p.id, tot + 1);
}

// ===== Controls & Tests =====
window.addEventListener('keydown',function(e){ if(e.key==='T' && e.shiftKey){ const b=document.getElementById('runTests'); if(b) b.classList.toggle('dev'); } });
function startNewRound(){
  const n = parseInt(document.getElementById('playerCount').value, 10);
  freshPlayers(n);
  state.dealer = Math.floor(Math.random() * n);
  dealRound();
  document.getElementById('status').textContent = 'Round in progress. ' + state.players[state.turn].name + ' to play.';
  logClear();
  const starter = state.players[state.turn];
  log('New game started. Dealer: ' + state.players[state.dealer].name + '. ' + (starter.isHuman ? 'You start.' : (starter.name + ' starts.')));
  render();
  const btn = document.getElementById('newRound');
  btn.disabled = true; btn.title = 'Game in progress';
  if (!state.players[state.turn].isHuman) aiTakeTurn(state.players[state.turn]);
}
function assert(cond,msg){ if(!cond) throw new Error(msg||'Assertion failed'); }
function clone(r){ return {r:r,s:'♠'}; }
async function runTests(){ logClear(); log('Running rule tests…'); const sel=parseInt(document.getElementById('playerCount').value,10);
  freshPlayers(2); state.dealer=0; dealRound(); state.pile=[clone('7'),clone('7')]; state.currentValue=RVAL['7']; state.currentCount=2; state.players[0].hand=[clone('10'),clone('10')]; state.players[0].slots=[]; state.roundActive=true; state.turn=0; const beforeTens=state.players[0].hand.length; await promptCountAndPlay('10','hand',2); assert(state.pile.length===0,'Ten clears'); assert(state.players[0].hand.length===beforeTens-1,'Playing 10 uses exactly one');
  freshPlayers(2); state.dealer=0; dealRound(); state.pile=[clone('5'),clone('5')]; state.currentValue=RVAL['5']; state.currentCount=2; state.players[0].hand=[clone('9'),clone('3')]; state.players[0].slots=[]; state.roundActive=true; state.turn=0; const before=state.players[0].hand.length; await playCards(state.players[0],'9','hand',1); assert(state.pile.length===0,'Overplay moves pile to hand'); assert(state.players[0].hand.length===before+2,'Attempted over card remains in hand; pile added'); assert(state.turn===0,'Same player continues after pickup');
  freshPlayers(2); state.dealer=0; dealRound(); state.pile=[clone('6'),clone('6'),clone('6')]; state.currentValue=RVAL['6']; state.currentCount=3; state.players[0].hand=[clone('6')]; state.players[0].slots=[]; state.roundActive=true; state.turn=0; await playCards(state.players[0],'6','hand',1); assert(state.pile.length===0,'Four-of-a-kind clears'); assert(state.turn===0,'Same player continues after clear');
  freshPlayers(2); state.dealer=0; dealRound(); state.players[0].hand=[clone('4')]; state.players[0].slots=[{down:null,up:clone('4')},{down:null,up:null},{down:null,up:null},{down:null,up:null}]; state.pile=[]; state.currentValue=null; state.currentCount=0; state.roundActive=true; state.turn=0; const pk1=document.getElementById('picker'); await promptCountAndPlay('4','hand',1); assert(pk1.style.display==='flex','Picker shown for optional include'); const cb=pk1.querySelector('#incfu'); assert(cb && cb.checked,'Include face-up is checked by default'); const buttons=[...pk1.querySelectorAll('.row button')]; buttons[0].click(); await sleep(50); assert(state.pile.length===1,'Played exactly one after picker'); assert(state.currentValue===RVAL['4'],'Active value set to played rank');
  freshPlayers(2); state.dealer=0; dealRound(); state.players[0].hand=[undefined, clone('A')]; state.pile=[clone('2'), undefined, clone('3')]; try{ render(); assert(true,'Render robust'); }catch(e){ throw new Error('Render should handle undefined cards safely'); }
  freshPlayers(2); state.dealer=0; dealRound(); state.players[1].isHuman=false; state.turn=1; const sl={down:clone('K'),up:null}; state.players[1].slots=[sl,{down:null,up:null},{down:null,up:null},{down:null,up:null}]; const pk=document.getElementById('picker'); pk.style.display='none'; await tryFlipFaceDownSlot(0); assert(pk.style.display!=='flex','AI blind flip should not show modal');
  for(let n=2;n<=6;n++){ freshPlayers(n); state.dealer=0; dealRound(); state.players.forEach(function(pl){ assert(pl.hand.length===11,'Each hand has 11'); assert(pl.slots.length===4,'Exactly 4 slots'); pl.slots.forEach(function(s){ assert(!!(s&&s.up) && !!(s&&s.down),'Slot has up & down'); }); }); }
  freshPlayers(2); state.dealer=0; dealRound(); state.pile=[clone('5')]; state.currentValue=RVAL['5']; state.currentCount=1; state.turn=0; state.players[0].slots=[{down:clone('9'),up:null},{down:null,up:null},{down:null,up:null},{down:null,up:null}]; const hBefore=state.players[0].hand.length; await tryFlipFaceDownSlot(0); assert(state.pile.length===0,'Pile cleared to hand on blind overplay'); assert(state.players[0].hand.length===hBefore+2,'Picked up previous pile + flipped card'); assert(state.turn===0,'Same player continues after pickup');
  freshPlayers(4); assert(state.players[1].name && state.players[1].name.endsWith(' (AI)'),'AI name #1 assigned'); assert(state.players[2].name && state.players[2].name.endsWith(' (AI)'),'AI name #2 assigned');
  freshPlayers(2); state.dealer=0; dealRound(); state.players[0].slots=[{down:clone('9'),up:null},{down:null,up:null},{down:null,up:null},{down:null,up:null}]; state.players[0].hand=[clone('9'), clone('9')]; state.pile=[]; state.currentValue=null; state.currentCount=0; state.turn=0; await tryFlipFaceDownSlot(0); const pk2=document.getElementById('picker'); const btns=[...pk2.querySelectorAll('.choices button')]; assert(btns.length>=1,'Reveal choice shows count buttons');

  document.getElementById('playerCount').value=String(sel); resetAll(); toast('Tests passed.'); log('Tests passed.'); }
function resetAll(){ const n=parseInt(document.getElementById('playerCount').value,10); freshPlayers(n); state.dealer=-1; state.matchActive=true; logClear(); render(); }

// Settings modal wiring
function openSettings(){
  const m = document.getElementById('settingsModal');
  m.style.display = 'flex';
    // ----- Tabs (Gameplay / Appearance) -----
  const tabGameplayBtn   = document.getElementById('tabGameplay');
  const tabAppearanceBtn = document.getElementById('tabAppearance');
  const gameplayTab      = document.getElementById('gameplayTab');
  const appearanceTab    = document.getElementById('appearanceTab');

  function showTab(which){
    const gp = which === 'gameplay';
    gameplayTab.style.display   = gp ? '' : 'none';
    appearanceTab.style.display = gp ? 'none' : '';
    tabGameplayBtn.classList.toggle('active', gp);
    tabAppearanceBtn.classList.toggle('active', !gp);
  }
  tabGameplayBtn.onclick   = ()=> showTab('gameplay');
  tabAppearanceBtn.onclick = ()=> showTab('appearance');
  showTab('gameplay'); // default when opening


  // Ensure arrays exist in settings
  if (!Array.isArray(settings.tableCustomColors)) settings.tableCustomColors = [];
  if (!Array.isArray(settings.cardBackFavs))      settings.cardBackFavs = [];

  // --- Wire toggles/inputs (auto-save on change) ---
  const p  = document.getElementById('setPauseBefore');
  const w  = document.getElementById('setWarnOn');
  const t  = document.getElementById('setWarnThresh');
  const s  = document.getElementById('setSuits');
  const mt = document.getElementById('setMiniTap');
  const sh = document.getElementById('setShowHint');
  const ap = document.getElementById('setAutoPlayAll');
  ap.checked = !!settings.autoPlayCopies;
  ap.onchange = ()=>{ settings.autoPlayCopies = ap.checked; saveSettings(); };

    // ----- Card face theme chips -----
  const cfClassic = document.getElementById('cfClassic');
  const cfDark    = document.getElementById('cfDark');
  function paintCF(){
    cfClassic.classList.toggle('selected', settings.cardFaceTheme === 'classic');
    cfDark.classList.toggle('selected',    settings.cardFaceTheme === 'dark');
  }
  cfClassic.onclick = ()=>{ settings.cardFaceTheme = 'classic'; saveSettings(); paintCF(); render(); };
  cfDark.onclick    = ()=>{ settings.cardFaceTheme = 'dark';    saveSettings(); paintCF(); render(); };
  paintCF();

  // set current values
  p.checked  = !!settings.pauseBefore;
  w.checked  = !!settings.warnOn;
  t.value    = String(settings.warnThresh ?? 5);
  s.checked  = !!settings.showSuits;
  mt.checked = !!settings.miniTap;
  sh.checked = !!settings.showHintBtn;
  ap.checked = !!settings.autoPlayCopies;

  // auto-save handlers
  p.onchange = ()=>{ settings.pauseBefore = p.checked; saveSettings(); };
  w.onchange = ()=>{ settings.warnOn      = w.checked; saveSettings(); };
  t.onchange = ()=>{ settings.warnThresh  = Math.max(1, Math.min(30, parseInt(t.value||'5',10))); saveSettings(); };
  s.onchange = ()=>{ settings.showSuits   = s.checked; saveSettings(); render(); };
  mt.onchange= ()=>{ settings.miniTap     = mt.checked; saveSettings(); };
  sh.onchange= ()=>{ settings.showHintBtn = sh.checked; saveSettings(); render(); };
  ap.onchange= ()=>{ settings.autoPlayCopies = ap.checked; saveSettings(); };

  // ===== TABLE COLOR =====
  const presetWrap = document.getElementById('tablePresetChips');
  const addBtn     = document.getElementById('tableColorAdd');
  const editBtn    = document.getElementById('tableColorEdit');
  const colorPick  = document.getElementById('tableColorPicker');

  const PRESETS = [
    {name:'green', hex:'#0a5a3c'},
    {name:'blue',  hex:'#153a68'},
    {name:'red',   hex:'#7e1515'}
  ];

  function applyTable(hex){
    document.documentElement.style.setProperty('--felt', hex);
    document.documentElement.style.setProperty('--felt-dark', hex);
    // derive toggle color immediately from new felt (CSS uses color-mix)
    settings.tableColor = hex;
    saveSettings();
  }

  function quickChip(hex){
    const b = document.createElement('button');
    b.type='button';
    b.className='color-chip';
    b.style.background = hex;
    b.title = hex;
    b.onclick = ()=> applyTable(hex);
    return b;
  }

  let tableEditMode = false;

  function toColorInput(hex){
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.fillStyle = hex;
    return ctx.fillStyle.length === 7 ? ctx.fillStyle : '#000000';
  }

  function renderTableRow(){
    presetWrap.innerHTML = '';

    if (!tableEditMode){
      // Presets as chips
      PRESETS.forEach(p => presetWrap.appendChild(quickChip(p.hex)));
      // Customs as chips
      settings.tableCustomColors.forEach(hex => presetWrap.appendChild(quickChip(hex)));
    } else {
  // Edit mode: keep colored chips; click the colored box to apply.
  PRESETS.forEach(p=>{
    const item = document.createElement('div');
    item.className='chip-item';

    const box = document.createElement('div');
    box.className='chip-box';
    box.style.background = p.hex;
    box.title = p.hex;
    box.onclick = ()=> applyTable(p.hex); // colored box = use

    const tools = document.createElement('div');
    tools.className='chip-tools';
    // No buttons for presets in edit mode

    item.append(box, tools);
    presetWrap.appendChild(item);
  });

  settings.tableCustomColors.forEach((hex, idx)=>{
    const item = document.createElement('div');
    item.className='chip-item';

    const box = document.createElement('div');
    box.className='chip-box';
    box.style.background = hex;
    box.title = hex;
    box.onclick = ()=> applyTable(hex); // colored box = use

    const tools = document.createElement('div');
    tools.className='chip-tools';

    const editSmall = document.createElement('button');
    editSmall.className='chip-mini-btn';
    editSmall.textContent='Edit';
    editSmall.onclick = ()=>{
      colorPick.value = toColorInput(hex);
      colorPick.onchange = ()=>{
        const nv = colorPick.value;
        settings.tableCustomColors[idx] = nv;
        applyTable(nv);
        renderTableRow();
      };
      colorPick.click();
    };

    const delBtn = document.createElement('button');
    delBtn.className='chip-mini-btn';
    delBtn.textContent='Delete';
    delBtn.onclick = ()=>{
      settings.tableCustomColors.splice(idx,1);
      saveSettings();
      renderTableRow();
    };

    tools.append(editSmall, delBtn);
    item.append(box, tools);
    presetWrap.appendChild(item);
  });
}

    editBtn.textContent = tableEditMode ? 'Done' : 'Edit';
  }

    // Native picker is triggered by <label for="tableColorPicker"> in HTML
  colorPick.onchange = ()=>{
    const val = colorPick.value;
    if (!settings.tableCustomColors.includes(val)){
      settings.tableCustomColors.push(val);
    }
    applyTable(val);
    renderTableRow();
  };

  editBtn.onclick = ()=>{ tableEditMode = !tableEditMode; renderTableRow(); };

  renderTableRow();
  if (settings.tableColor) applyTable(settings.tableColor);

  // ===== CARD BACKS =====
  const OPTIONS = [
    {value:'solid-blue',      label:'Solid Blue'},
    {value:'solid-red',       label:'Solid Red'},
    {value:'solid-black',     label:'Solid Black'},
    {value:'solid-green',     label:'Solid Green'},
    {value:'mix-red-blue',    label:'Red/Blue Mix'},
    {value:'mix-blue-black',  label:'Blue/Black Mix'},
    {value:'mix-red-black',   label:'Red/Black Mix'},
    {value:'mix-red-green',   label:'Red/Green Mix'},
    {value:'mix-green-black', label:'Green/Black Mix'},
    {value:'mix-green-blue',  label:'Green/Blue Mix'},
  ];
  const gallery      = document.getElementById('cardBackGallery');
  const previewThumb = document.getElementById('cardBackPreviewThumb');
  const previewLabel = document.getElementById('cardBackPreviewLabel');
  const ui           = document.getElementById('cardBackUI');
  const panel        = document.getElementById('cardBackPanel');
  const favRow       = document.getElementById('cardBackFavRow');
  const favWrap      = document.getElementById('cardBackFavs');
  const favEditBtn   = document.getElementById('cardBackEdit');

  const addSolid     = document.getElementById('addSolidBack');
  const addMix       = document.getElementById('addMixBack');
  const pickSolid    = document.getElementById('cardBackSolidPicker');
  const pickMixA     = document.getElementById('cardBackMixA');
  const pickMixB     = document.getElementById('cardBackMixB');

  function setThumbBackground(el, style){
    el.removeAttribute('data-style');
    el.style.background = '';
    if (style.startsWith && style.startsWith('solid:')){
      const hex = style.slice(6);
      el.style.background = `linear-gradient(180deg, ${hex}, ${hex})`;
    } else if (style.startsWith && style.startsWith('mix:')){
      const [a,b] = style.slice(4).split(',');
      el.style.background = `conic-gradient(from 0deg at 50% 50%, ${a}, ${b}, ${a})`;
    } else {
      el.setAttribute('data-style', style);
    }
  }
  function renderPreview(){
    setThumbBackground(previewThumb, settings.cardBack);
    previewLabel.textContent = ''; // visuals only
  }
  function saveCardBack(val){
    settings.cardBack = val;
    saveSettings();
    renderPreview();
    renderMiniPile();
  }

  function buildGallery(){
    gallery.innerHTML = '';
    OPTIONS.forEach(opt=>{
      const btn = document.createElement('button');
      btn.type='button';
      btn.className='cardback-option' + (settings.cardBack===opt.value ? ' selected' : '');
      btn.innerHTML=`<div class="cardback-thumb" data-style="${opt.value}"></div>`;
      btn.onclick=()=>{
        saveCardBack(opt.value);
        document.querySelectorAll('#cardBackGallery .cardback-option.selected')
          .forEach(n=>n.classList.remove('selected'));
        btn.classList.add('selected');
      };
      gallery.appendChild(btn);
    });
  }

  let favEditMode = false;
  function renderCardBackFavs(){
    const favs = settings.cardBackFavs || [];
    if (favs.length === 0){
      favRow.style.display = 'none';
      favWrap.innerHTML = '';
      return;
    }
    favRow.style.display = '';
    favWrap.innerHTML = '';

    favs.forEach((style, idx)=>{
      const item = document.createElement('div');
      item.className = 'fav-item';

      const th = document.createElement('div');
      th.className='cardback-thumb';
      setThumbBackground(th, style);
      item.append(th);

      if (favEditMode){
        const tools = document.createElement('div');
        tools.className = 'fav-tools';

        const useBtn = document.createElement('button'); useBtn.className='fav-mini-btn'; useBtn.textContent='Use';
        useBtn.onclick = ()=> saveCardBack(style);

        const editBtn = document.createElement('button'); editBtn.className='fav-mini-btn'; editBtn.textContent='Edit';
        editBtn.onclick = ()=>{
          if (style.startsWith('solid:')){
            pickSolid.value = style.slice(6);
            pickSolid.onchange = ()=>{
              const nv = 'solid:' + pickSolid.value;
              settings.cardBackFavs[idx] = nv;
              saveSettings(); renderCardBackFavs();
            };
            pickSolid.click();
          } else if (style.startsWith('mix:')){
            const [a,b] = style.slice(4).split(',');
            pickMixA.value = a; pickMixB.value = b;
            pickMixA.onchange = ()=>{
              pickMixB.onchange = ()=>{
                const nv = 'mix:' + pickMixA.value + ',' + pickMixB.value;
                settings.cardBackFavs[idx] = nv;
                saveSettings(); renderCardBackFavs();
              };
              pickMixB.click();
            };
            pickMixA.click();
          }
        };

        const delBtn = document.createElement('button'); delBtn.className='fav-mini-btn'; delBtn.textContent='Delete';
        delBtn.onclick = ()=>{
          settings.cardBackFavs.splice(idx,1);
          saveSettings(); renderCardBackFavs();
        };

        tools.append(useBtn, editBtn, delBtn);
        item.append(tools);
      } else {
        // normal click selects
        item.onclick = ()=> saveCardBack(style);
      }

      favWrap.append(item);
    });
  }

  // Preview toggles panel
  const previewBox = document.getElementById('cardBackPreview');
  function setExpanded(on){
    ui.dataset.expanded = on ? 'true' : 'false';
    panel.style.display = on ? 'block' : 'none';
  }
  previewBox.onclick = ()=> setExpanded(ui.dataset.expanded !== 'true');

  // Create new custom
    // Triggered by <label for="cardBackSolidPicker"> in HTML
  pickSolid.onchange = ()=>{
    const val = 'solid:' + pickSolid.value;
    if (!settings.cardBackFavs.includes(val)) settings.cardBackFavs.push(val);
    saveSettings(); renderCardBackFavs(); saveCardBack(val);
  };

    addMix.onclick = ()=>{
    let editor = document.getElementById('mixEditorRow');
    if (!editor){
      editor = document.createElement('div');
      editor.id = 'mixEditorRow';
      editor.className = 'row';
      editor.style.gap = '8px';
      editor.innerHTML = `
        <span style="opacity:.9">Pick two colors</span>
        <input type="color" id="mixA" value="#b11f1f">
        <input type="color" id="mixB" value="#153a68">
        <button id="mixSave" class="themed-btn">Save</button>
        <button id="mixCancel" class="themed-btn-ghost">Cancel</button>
      `;
      document.getElementById('cardBackPanel').appendChild(editor);

      editor.querySelector('#mixSave').onclick = ()=>{
        const a = editor.querySelector('#mixA').value;
        const b = editor.querySelector('#mixB').value;
        const val = 'mix:' + a + ',' + b;
        if (!settings.cardBackFavs.includes(val)) settings.cardBackFavs.push(val);
        saveSettings(); renderCardBackFavs(); saveCardBack(val);
        editor.remove();
      };
      editor.querySelector('#mixCancel').onclick = ()=> editor.remove();
    }
  };

  // Favorites edit toggle
  const favEditBtnEl = document.getElementById('cardBackEdit');
  favEditBtnEl.onclick = ()=>{
    favEditMode = !favEditMode;
    favEditBtnEl.textContent = favEditMode ? 'Done' : 'Edit';
    renderCardBackFavs();
  };

  // Initial renders
  renderPreview();
  buildGallery();
  renderCardBackFavs();

  // Close button (single action)
  const closeBtn = document.getElementById('setClose');
  closeBtn.onclick = ()=>{ m.style.display = 'none'; };
}

function saveSettingsFromUI(){
  const p  = document.getElementById('setPauseBefore');
  const w  = document.getElementById('setWarnOn');
  const t  = document.getElementById('setWarnThresh');
  const s  = document.getElementById('setSuits');
  const mt = document.getElementById('setMiniTap');
  const sh = document.getElementById('setShowHint');
  const ap = document.getElementById('setAutoPlayAll');

  settings.pauseBefore = !!p.checked;
  settings.warnOn      = !!w.checked;
  settings.warnThresh  = Math.max(1, Math.min(30, parseInt(t.value || '5',10)));
  settings.showSuits   = !!s.checked;
  settings.miniTap     = !!mt.checked;
  settings.showHintBtn = !!sh.checked;
  settings.autoPlayCopies = !!ap.checked;

  saveSettings();
  document.getElementById('settingsModal').style.display = 'none';
  render();
}

// Init
loadSettings();
try{ const savedDiff=localStorage.getItem('tens_ai_diff'); if(savedDiff){ const el=document.getElementById('aiDifficulty'); if(el) el.value=savedDiff; } }catch(e){}
resetAll();
initMiniObserver();

document.body.dataset.cardback=settings.cardBack;

// Events
  document.getElementById('playerCount').addEventListener('change',resetAll);
  document.getElementById('aiDifficulty').addEventListener('change',function(){ const sel=document.getElementById('aiDifficulty').value; try{ localStorage.setItem('tens_ai_diff', sel); }catch(e){} log('AI difficulty set to '+displayDiffLabel()); });
  document.getElementById('newRound').addEventListener('click',startNewRound);
  document.getElementById('newGame').addEventListener('click',function(){ forfeitMatch(); });
  document.getElementById('runTests').addEventListener('click',function(){ runTests(); });
  document.getElementById('settingsBtn').addEventListener('click',openSettings);
  document.getElementById('settingsBtn').addEventListener('click',openSettings);
  document.querySelector('#settingsModal .backdrop').addEventListener('click',function(){
  document.getElementById('settingsModal').style.display='none';
  });
  document.querySelector('#settingsModal .backdrop').addEventListener('click',function(){ document.getElementById('settingsModal').style.display='none'; });
  document.getElementById('scoreToggle').addEventListener('click',function(){ const sb=document.getElementById('scorebar'); const c=sb.classList.toggle('collapsed'); document.getElementById('scoreToggle').textContent = c? 'Info ▾' : 'Info ▴'; });
  document.getElementById('hintBtn').addEventListener('click',openHint);
  document.querySelector('#hintModal .backdrop').addEventListener('click',function(){ document.getElementById('hintModal').style.display='none'; });
  document.getElementById('hintClose').addEventListener('click',function(){ document.getElementById('hintModal').style.display='none'; });
