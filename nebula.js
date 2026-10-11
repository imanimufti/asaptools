/* nebula-field: living particle field. Modes: field | orb | graph.
   Attrs: state(open|locked|resched) certainty(0..1) density(0..1) motion(0..1) nodes(JSON) movemode(0|1)
   Drag physics: shift-drag (or movemode) pulls a node; pull propagates along link springs
   with per-hop falloff; on release the force layout re-settles toward canonical homes. */
(function () {
  if (customElements.get('nebula-field')) return;
  const PAL = {
    open:   [[73,201,166],[125,232,201],[46,143,122],[160,240,220]],
    locked: [[232,194,104],[245,217,143],[201,162,74],[255,236,190]],
    resched:[[224,138,82],[240,164,136],[217,80,63],[248,196,160]]
  };
  const lerp = (a,b,t)=>a+(b-a)*t;
  class NebulaField extends HTMLElement {
    static get observedAttributes(){return ['state','certainty','density','motion','nodes','mode','movemode'];}
    constructor(){
      super();
      this.attachShadow({mode:'open'}).innerHTML =
        '<style>:host{display:block;position:relative;contain:strict}canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none}</style><canvas></canvas>';
      this._cv = this.shadowRoot.querySelector('canvas');
      this._ctx = this._cv.getContext('2d');
      this._pal = PAL.open.map(c=>c.slice());
      this._palT = PAL.open;
      this._cert = 0; this._certT = 0;
      this._dens = .5; this._densT = .5;
      this._parts = []; this._t = Math.random()*100;
      this._nodes = []; this._hover = null;
      this._sim = {}; this._links = [];
      this._dragId = null; this._dragPos = null; this._dragVel = [0,0];
      this._disturb = 0; this._shift = false;
      this._down = this._down.bind(this); this._move = this._move.bind(this); this._up2 = this._up2.bind(this);
      this._key = this._key.bind(this);
    }
    attributeChangedCallback(n,_,v){
      if (n==='state') this._palT = PAL[v] || PAL.open;
      if (n==='certainty') this._certT = Math.max(0,Math.min(1,parseFloat(v)||0));
      if (n==='density') this._densT = Math.max(0,Math.min(1,parseFloat(v)||0));
      if (n==='motion') this._motion = Math.max(0,Math.min(1,parseFloat(v??1)));
      if (n==='movemode') this._moveMode = v==='1'||v==='true';
      if (n==='nodes'){ try{this._nodes=JSON.parse(v)||[];}catch(e){this._nodes=[];} this._buildSim(true); }
    }
    connectedCallback(){
      this._ro = new ResizeObserver(()=>this._resize());
      this._ro.observe(this);
      this._resize();
      this._cv.addEventListener('pointerdown', this._down);
      this._cv.addEventListener('pointermove', this._move);
      this._cv.addEventListener('pointerup', this._up2);
      this._cv.addEventListener('pointercancel', this._up2);
      window.addEventListener('keydown', this._key);
      window.addEventListener('keyup', this._key);
      const loop = ()=>{ this._raf = requestAnimationFrame(loop); this._step(); };
      loop();
    }
    disconnectedCallback(){
      cancelAnimationFrame(this._raf); this._ro && this._ro.disconnect();
      window.removeEventListener('keydown', this._key);
      window.removeEventListener('keyup', this._key);
    }
    _key(e){ this._shift = e.shiftKey; }
    _resize(){
      const r = this.getBoundingClientRect(); if (!r.width) return;
      const dpr = Math.min(2, devicePixelRatio||1);
      this._w = r.width; this._h = r.height;
      this._cv.width = r.width*dpr; this._cv.height = r.height*dpr;
      this._ctx.setTransform(dpr,0,0,dpr,0,0);
      this._seed(); this._buildSim(true);
    }
    _seed(){
      const area = this._w*this._h;
      const base = this.getAttribute('mode')==='orb' ? area/220 : area/1400;
      const n = Math.max(40, Math.min(900, base));
      this._parts = Array.from({length:n},()=>({
        x: Math.random()*this._w, y: Math.random()*this._h,
        s: .4+Math.random()*1.6, p: Math.random()*6.28,
        c: Math.floor(Math.random()*4), a: .15+Math.random()*.55
      }));
    }
    _homeXY(nd){
      const cx=this._w/2, cy=this._h/2, R=Math.min(this._w,this._h)*.42;
      const wob = Math.sin(this._t*.35 + (nd.angle||0)*7)*.035*(1-this._cert*.6);
      const a=(nd.angle||0)+wob, d=(nd.dist||0)*R;
      return [cx+Math.cos(a)*d, cy+Math.sin(a)*d];
    }
    _buildSim(keep){
      if(!this._w) return;
      const old = this._sim; this._sim = {};
      for(const nd of this._nodes){
        const [hx,hy]=this._homeXY(nd);
        const prev = keep && old[nd.id];
        this._sim[nd.id] = prev ? prev : {x:hx,y:hy,vx:0,vy:0};
      }
      // links: everything → star, plus cluster members to each other
      this._links = [];
      const star = this._nodes.find(n=>n.type==='star');
      const byCluster = {};
      for(const nd of this._nodes){
        if(nd.type==='ghost') continue;
        if(star && nd!==star) this._links.push([nd.id, star.id, nd.type==='portal']);
        if(nd.cluster) (byCluster[nd.cluster]=byCluster[nd.cluster]||[]).push(nd.id);
      }
      for(const k in byCluster){ const m=byCluster[k];
        for(let i=0;i<m.length;i++)for(let j=i+1;j<m.length;j++) this._links.push([m[i],m[j],false,true]);
      }
    }
    _nodeXY(nd){ const s=this._sim[nd.id]; return s?[s.x,s.y]:this._homeXY(nd); }
    _hit(e){
      const r=this.getBoundingClientRect(), mx=e.clientX-r.left, my=e.clientY-r.top;
      let best=null, bd=26;
      for (const nd of this._nodes){ if(nd.type==='ghost')continue;
        const [x,y]=this._nodeXY(nd), d=Math.hypot(mx-x,my-y);
        if(d<bd){bd=d;best=nd;}
      }
      return [best, mx, my];
    }
    _down(e){
      if(!this._nodes.length) return;
      const [nd,mx,my]=this._hit(e);
      if(!nd) return;
      this._pressPt=[mx,my]; this._pressNd=nd; this._dragMoved=false;
      if((this._moveMode||e.shiftKey) && nd.type!=='star'){
        this._dragId=nd.id; this._dragPos=[mx,my]; this._dragVel=[0,0];
        this._cv.setPointerCapture(e.pointerId);
        this.style.cursor='grabbing';
      }
    }
    _move(e){
      const r=this.getBoundingClientRect(), mx=e.clientX-r.left, my=e.clientY-r.top;
      if(this._dragId){
        this._dragVel=[mx-this._dragPos[0], my-this._dragPos[1]];
        this._dragPos=[mx,my];
        if(this._pressPt && Math.hypot(mx-this._pressPt[0],my-this._pressPt[1])>4) this._dragMoved=true;
        this._disturb=1;
        this._dropTarget=this._calcDrop(mx,my);
        return;
      }
      const [nd]=this._hit(e);
      this._hover=nd;
      this.style.cursor = nd ? ((this._moveMode||e.shiftKey)&&nd.type!=='star'?'grab':'pointer') : 'default';
    }
    _calcDrop(mx,my){
      // person target: another person node within 30px
      for(const nd of this._nodes){
        if(nd.id===this._dragId) continue;
        if(nd.type&&nd.type!=='person') continue;
        const [x,y]=this._nodeXY(nd);
        if(Math.hypot(mx-x,my-y)<30) return {type:'person',pid:nd.id};
      }
      // cluster target: inside a halo
      const geo=this._clusterGeo||{};
      for(const name in geo){ const [cx,cy,r]=geo[name];
        if(Math.hypot(mx-cx,my-cy)<r) return {type:'cluster',name};
      }
      return null;
    }
    _up2(e){
      const wasDrag=this._dragId, moved=this._dragMoved;
      if(wasDrag&&moved){
        this.dispatchEvent(new CustomEvent('nebula-nodedrop',{detail:{id:wasDrag,target:this._dropTarget||null},bubbles:true,composed:true}));
      }
      this._dropTarget=null;
      this._dragId=null; this._dragPos=null;
      this.style.cursor='default';
      if(this._pressNd && !(wasDrag&&moved)){
        this.dispatchEvent(new CustomEvent('nebula-nodeclick',{detail:this._pressNd,bubbles:true,composed:true}));
      }
      this._pressNd=null;
    }
    _simStep(){
      if(!this._nodes.length) return;
      const K_HOME=.05, K_STAR=.42, K_LINK=.045, DAMP=.84;
      const ids=Object.keys(this._sim);
      const F={}; for(const id of ids) F[id]=[0,0];
      for(const nd of this._nodes){
        const s=this._sim[nd.id]; if(!s) continue;
        const [hx,hy]=this._homeXY(nd);
        const k = nd.type==='star' ? K_STAR : nd.type==='ghost' ? .12 : K_HOME;
        F[nd.id][0]+=(hx-s.x)*k; F[nd.id][1]+=(hy-s.y)*k;
      }
      for(const [a,b]of this._links.map(l=>[l[0],l[1]])){
        const sa=this._sim[a], sb=this._sim[b]; if(!sa||!sb) continue;
        const na=this._nodes.find(n=>n.id===a), nb=this._nodes.find(n=>n.id===b);
        const [hax,hay]=this._homeXY(na), [hbx,hby]=this._homeXY(nb);
        const L0=Math.hypot(hbx-hax,hby-hay);
        let dx=sb.x-sa.x, dy=sb.y-sa.y, d=Math.hypot(dx,dy)||1;
        const f=K_LINK*(d-L0)/d;
        F[a][0]+=dx*f; F[a][1]+=dy*f;
        F[b][0]-=dx*f; F[b][1]-=dy*f;
      }
      // soft repulsion so the settle finds a natural, non-overlapping equilibrium
      for(let i=0;i<ids.length;i++)for(let j=i+1;j<ids.length;j++){
        const sa=this._sim[ids[i]], sb=this._sim[ids[j]];
        let dx=sb.x-sa.x, dy=sb.y-sa.y, d=Math.hypot(dx,dy);
        if(d<48&&d>0){ const f=(48-d)/48*.5/d;
          F[ids[i]][0]-=dx*f; F[ids[i]][1]-=dy*f;
          F[ids[j]][0]+=dx*f; F[ids[j]][1]+=dy*f; }
      }
      for(const nd of this._nodes){
        const s=this._sim[nd.id]; if(!s) continue;
        if(nd.id===this._dragId && this._dragPos){
          s.vx=this._dragPos[0]-s.x; s.vy=this._dragPos[1]-s.y;
          s.x=this._dragPos[0]; s.y=this._dragPos[1];
          continue;
        }
        s.vx=(s.vx+F[nd.id][0])*DAMP; s.vy=(s.vy+F[nd.id][1])*DAMP;
        s.x+=s.vx; s.y+=s.vy;
      }
    }
    _step(){
      const ctx=this._ctx, w=this._w, h=this._h; if(!w) return;
      this._cert = lerp(this._cert, this._certT, .04);
      this._dens = lerp(this._dens, this._densT, .04);
      this._disturb = this._dragId ? 1 : this._disturb*.96;
      for(let i=0;i<4;i++)for(let j=0;j<3;j++) this._pal[i][j]=lerp(this._pal[i][j],this._palT[i][j],.05);
      const mo = this._motion==null?1:this._motion;
      const speed = (.25 + 1.75*(1-this._cert)) * mo * (1+this._disturb*1.3);
      const turb = .6 + 1.6*(1-this._cert) + this._disturb;
      this._t += .016*(.25 + 1.75*(1-this._cert))*mo;
      this._simStep();
      const t=this._t, orb=this.getAttribute('mode')==='orb';
      const cx=w/2, cy=h/2, orbR=Math.min(w,h)/2 - 2;
      ctx.clearRect(0,0,w,h);
      const breathe = .5+.5*Math.sin(t*.6);
      const g=ctx.createRadialGradient(cx,cy,0,cx,cy,Math.max(w,h)*.6);
      const p0=this._pal[2];
      g.addColorStop(0,`rgba(${p0[0]|0},${p0[1]|0},${p0[2]|0},${(.10+.05*breathe)*(.3+this._dens)})`);
      g.addColorStop(1,'rgba(0,0,0,0)');
      ctx.fillStyle=g; ctx.fillRect(0,0,w,h);
      const vis = Math.floor(this._parts.length*(.35+.65*this._dens));
      const dp = this._dragId && this._dragPos, dv=this._dragVel;
      for(let i=0;i<vis;i++){
        const p=this._parts[i];
        const ang = Math.sin(p.x*.011+t)*turb + Math.cos(p.y*.013-t*.8)*turb + p.p;
        p.x += Math.cos(ang)*p.s*speed*.5;
        p.y += Math.sin(ang)*p.s*speed*.5;
        if(dp){ // wake: sweep nearby particles along the drag
          const d=Math.hypot(p.x-dp[0],p.y-dp[1]);
          if(d<90){ const f=(1-d/90)*.8; p.x+=dv[0]*f; p.y+=dv[1]*f; }
        }
        if(orb){
          const dx=p.x-cx, dy=p.y-cy, d=Math.hypot(dx,dy);
          if(d>orbR){ p.x=cx+dx/d*orbR*.2; p.y=cy+dy/d*orbR*.2; }
        } else {
          if(p.x<-4)p.x=w+4; if(p.x>w+4)p.x=-4; if(p.y<-4)p.y=h+4; if(p.y>h+4)p.y=-4;
        }
        const c=this._pal[p.c];
        const tw = p.a*(.55+.45*Math.sin(t*2+p.p*9));
        ctx.fillStyle=`rgba(${c[0]|0},${c[1]|0},${c[2]|0},${tw})`;
        const r=p.s*(p.c===3?1.2:.8);
        ctx.fillRect(p.x-r/2,p.y-r/2,r,r);
      }
      if(this._nodes.length) this._drawGraph(ctx,t);
    }
    _drawGraph(ctx,t){
      const P=this._pal, main=P[0], hi=P[1];
      // links — elastic: stretch thins and fades them
      for(const L of this._links){
        const na=this._nodes.find(n=>n.id===L[0]), nb=this._nodes.find(n=>n.id===L[1]);
        if(!na||!nb) continue;
        const [ax,ay]=this._nodeXY(na), [bx,by]=this._nodeXY(nb);
        const [hax,hay]=this._homeXY(na), [hbx,hby]=this._homeXY(nb);
        const L0=Math.hypot(hbx-hax,hby-hay)||1, d=Math.hypot(bx-ax,by-ay)||1;
        const stretch=Math.min(1, Math.pow(L0/d,1.5));
        const base = L[3] ? .09 : .13;
        ctx.strokeStyle=`rgba(${main[0]|0},${main[1]|0},${main[2]|0},${(base*stretch+.02).toFixed(3)})`;
        ctx.lineWidth=Math.max(.4, stretch);
        ctx.setLineDash(L[2]?[3,4]:[]);
        ctx.beginPath();ctx.moveTo(ax,ay);ctx.lineTo(bx,by);ctx.stroke();ctx.setLineDash([]);
      }
      ctx.lineWidth=1;
      // cluster halos — follow (and deform with) live member positions
      const clusters={};
      for(const nd of this._nodes){ if(nd.cluster){(clusters[nd.cluster]=clusters[nd.cluster]||[]).push(this._nodeXY(nd));} }
      this._clusterGeo={};
      for(const k in clusters){
        const pts=clusters[k];
        const cx=pts.reduce((s,p)=>s+p[0],0)/pts.length, cy=pts.reduce((s,p)=>s+p[1],0)/pts.length;
        const r=Math.max(...pts.map(p=>Math.hypot(p[0]-cx,p[1]-cy)))+26;
        this._clusterGeo[k]=[cx,cy,r];
        const dt=this._dropTarget;
        const hot=this._dragId&&dt&&dt.type==='cluster'&&dt.name===k;
        ctx.strokeStyle=`rgba(${hi[0]|0},${hi[1]|0},${hi[2]|0},${hot?.75:.28})`;
        ctx.setLineDash([2,5]);ctx.beginPath();ctx.arc(cx,cy,r,0,6.29);ctx.stroke();ctx.setLineDash([]);
        ctx.fillStyle=`rgba(${hi[0]|0},${hi[1]|0},${hi[2]|0},.6)`;
        ctx.font='10px "Space Grotesk",sans-serif';ctx.textAlign='center';
        ctx.fillText(k.toUpperCase(),cx,cy-r-7);
      }
      for(const nd of this._nodes){
        const [x,y]=this._nodeXY(nd);
        const drag = this._dragId===nd.id;
        const dt=this._dropTarget;
        const isTarget = this._dragId&&dt&&dt.type==='person'&&dt.pid===nd.id;
        if(isTarget){ ctx.strokeStyle=`rgba(${hi[0]|0},${hi[1]|0},${hi[2]|0},.9)`;
          ctx.setLineDash([3,3]);ctx.beginPath();ctx.arc(x,y,22,0,6.29);ctx.stroke();ctx.setLineDash([]); }
        const hov = drag || isTarget || (this._hover && this._hover.id===nd.id);
        if(nd.type==='star'){
          const pulse=1+.06*Math.sin(t*1.4);
          const g=ctx.createRadialGradient(x,y,0,x,y,44*pulse);
          g.addColorStop(0,`rgba(${hi[0]|0},${hi[1]|0},${hi[2]|0},.95)`);
          g.addColorStop(.25,`rgba(${main[0]|0},${main[1]|0},${main[2]|0},.5)`);
          g.addColorStop(1,'rgba(0,0,0,0)');
          ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,y,44*pulse,0,6.29);ctx.fill();
          ctx.fillStyle='rgba(255,255,255,.95)';ctx.beginPath();ctx.arc(x,y,3.5,0,6.29);ctx.fill();
        } else if(nd.type==='ghost'){
          ctx.fillStyle=`rgba(${main[0]|0},${main[1]|0},${main[2]|0},.28)`;
          ctx.beginPath();ctx.arc(x,y,3,0,6.29);ctx.fill();
        } else if(nd.type==='portal'){
          ctx.strokeStyle=`rgba(${hi[0]|0},${hi[1]|0},${hi[2]|0},${hov?1:.8})`;
          ctx.lineWidth=1.5;
          ctx.beginPath();ctx.arc(x,y,11+(hov?2:0),0,6.29);ctx.stroke();ctx.lineWidth=1;
          ctx.fillStyle=`rgba(${hi[0]|0},${hi[1]|0},${hi[2]|0},.35)`;
          ctx.beginPath();ctx.arc(x,y,5,0,6.29);ctx.fill();
        } else if(nd.type==='artifact'){
          ctx.save();ctx.translate(x,y);ctx.rotate(.785);
          ctx.fillStyle=`rgba(${main[0]|0},${main[1]|0},${main[2]|0},${hov?1:.75})`;
          ctx.fillRect(-5,-5,10,10);ctx.restore();
        } else {
          const R = drag?20:hov?16:12;
          const g=ctx.createRadialGradient(x,y,0,x,y,R);
          g.addColorStop(0,`rgba(${hi[0]|0},${hi[1]|0},${hi[2]|0},${drag?1:.9})`);
          g.addColorStop(1,'rgba(0,0,0,0)');
          ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,y,R,0,6.29);ctx.fill();
          ctx.fillStyle='rgba(255,255,255,.9)';
          ctx.beginPath();ctx.arc(x,y,nd.kdm?4:2.8,0,6.29);ctx.fill();
          if(nd.kdm){ ctx.strokeStyle=`rgba(${hi[0]|0},${hi[1]|0},${hi[2]|0},.9)`;
            ctx.beginPath();ctx.arc(x,y,7.5,0,6.29);ctx.stroke(); }
        }
        if(nd.label){
          ctx.font='11px "Space Grotesk",sans-serif';ctx.textAlign='center';
          ctx.fillStyle=`rgba(233,238,240,${hov?1:.78})`;
          ctx.fillText(nd.label,x,y+(nd.type==='star'?30:24));
          if(nd.sub){ ctx.font='9.5px "Space Grotesk",sans-serif';
            ctx.fillStyle='rgba(233,238,240,.4)';
            ctx.fillText(nd.sub,x,y+(nd.type==='star'?42:36)); }
        }
      }
    }
  }
  customElements.define('nebula-field', NebulaField);
})();
