// ===== Utility =====
const SUITS=["♠","♥","♦","♣"]; const RANKS=["A","2","3","4","5","6","7","8","9","10","J","Q","K"]; const RVAL=Object.fromEntries(RANKS.map((r,i)=>[r,i+1]));
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
function scoringValue(rank){ if(rank==='10')return 30; if(['J','Q','K'].includes(rank))return 10; if(rank==='A')return 1; return Number(rank); }
function decksForPlayers(p){ if(p===2)return 1; if(p<=5)return 2; if(p<=8)return 3; if(p<=10)return 4; if(p<=13)return 5; return 6; }
function makeDeck(n){ const d=[]; for(let k=0;k<n;k++){ for(const s of SUITS){ for(const r of RANKS){ d.push({r,s}); } } } return shuffle(d); }
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); const ai=a[i]; const aj=a[j]; a[i]=aj; a[j]=ai; } return a; }

// ===== Names for AI =====
const MALE_NAMES=["Greg","Paul","Alex","Jordan","Chris","Logan","Dylan","Corey","Brett","Terry"]; 
const FEMALE_NAMES=["Mary","Alicia","Ashley","Veronica","Kelly","Dana","Leslie","Sasha","Quinn","Avery"]; 
const AI_NAMES=[...MALE_NAMES,...FEMALE_NAMES];

// ===== Settings (with persistence) =====
const settings={ pauseBefore:false, warnOn:false, warnThresh:5, showSuits:false, miniTap:false, miniCorner:'tr', miniHidden:false, cardBack:'blueflame' };
function loadSettings(){ try{ const s=JSON.parse(localStorage.getItem('tens_settings')||'null'); if(s){ Object.assign(settings,s); } }catch(e){} document.body.dataset.cardback=settings.cardBack; }
function saveSettings(){ try{ localStorage.setItem('tens_settings',JSON.stringify(settings)); }catch(e){} document.body.dataset.cardback=settings.cardBack; }

// ===== State =====
const state={ players:[], pile:[], currentValue:null, currentCount:0, turn:0, roundActive:false, dealer:-1, matchActive:true, mustDeclare:new Set(), warnedAt:new Map(), roundStats:null, aiAdaptive:'medium' };
function freshPlayers(n){
  const needAI=Math.max(0,n-1);
  const pool=shuffle([...AI_NAMES]);
  const chosen=[]; for(let i=0;i<needAI;i++){ chosen.push(pool[i % pool.length]); }
  state.players=Array.from({length:n},(_,i)=>({id:i,name: i===0 ? 'You' : `${chosen[i-1]} (AI)`, isHuman:i===0, hand:[], slots:[], score:0}));
}
function nextDealer(){ state.dealer=(state.dealer+1)%state.players.length; }
function resetMatch(){ state.players.forEach(p=>p.score=0); state.dealer=-1; state.matchActive=true; logClear(); updateScores(); state.warnedAt.clear(); }

// ===== Deal (ensure 11 hand + 4 up/4 down) =====
function ensureDeckSizeFor(nPlayers){ const needEach=11+8; const needTotal=nPlayers*needEach; let decks=decksForPlayers(nPlayers); let deck=makeDeck(decks); while(deck.length<needTotal){ decks+=1; deck=makeDeck(decks); } return deck; }
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
function makeCardEl(card,small,hidden){ const d=document.createElement('div'); const rr=(card&&card.r)||''; const ss=(card&&card.s)||'♠'; d.className='card'+(small?' small':'')+(hidden?' faceDown':''); if(!hidden){ d.textContent=rr; if(ss==='♥'||ss==='♦') d.classList.add('red'); } return d; }
function groupByRank(cards){ const m={}; for(const c of cards){ if(!c||!c.r) continue; (m[c.r]||(m[c.r]=[])).push(c); } return m; }
function canPlayRank(rank){ if(rank==='10') return true; if(state.currentValue===null) return true; return RVAL[rank] <= state.currentValue; }

function render(){ const aiWrap=document.getElementById('aiTop'), meWrap=document.getElementById('human'); aiWrap.innerHTML=''; meWrap.innerHTML='';
  state.players.forEach((p,idx)=>{ const area=document.createElement('div'); area.className='playerArea'+(p.isHuman?' me':''); if(idx===state.turn && state.roundActive) area.classList.add('turnGlow');
    const hdr=document.createElement('div'); hdr.className='playerHeader'; const left=document.createElement('div'); left.innerHTML=`<b>${p.name}</b> <span class="badge">hand: ${p.hand.filter(Boolean).length}</span>`; const right=document.createElement('div'); right.innerHTML=`<span class="badge">table: ${faceUpCards(p).length + faceDownCount(p)}</span>`; hdr.append(left,right); area.append(hdr);
    const slotRow=document.createElement('div'); slotRow.style.display='grid'; slotRow.style.gridTemplateColumns='repeat(4, 56px)'; slotRow.style.gap='12px'; slotRow.style.marginBottom='14px';
    p.slots.forEach((s,slotIdx)=>{ const col=document.createElement('div'); col.style.height='76px'; col.style.position='relative';
      if(s && s.down){ const downEl=makeCardEl({r:'',s:'♠'},!p.isHuman,true); downEl.style.position='absolute'; downEl.style.top='10px'; downEl.style.left='
