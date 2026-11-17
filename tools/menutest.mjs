// Exercise real menu/HUD/render orchestration with DOM and GPU boundaries stubbed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SCENARIOS } from '../js/scenarios.js';
import { World } from '../js/world.js';
import { SIM_DT } from '../js/sim.js';
import { TYPES } from '../js/types.js';
import { buildModels } from '../js/models.js';
import { HUD } from '../js/hud.js';
import { V3, Quat } from '../js/math.js';
process.on('uncaughtException', e => { console.error(e.name + ': ' + e.message); console.error((e.stack || '').split('\n').filter(l => !l.includes('data:text/')).slice(1).join('\n')); process.exit(1); });
const nodes=new Map(),stored=new Map(),drawn=[];
const context=new Proxy({measureText:t=>({width:String(t).length*7}),fillText:t=>drawn.push(String(t))},{get:(o,k)=>o[k]??(()=>{}),set:(o,k,v)=>(o[k]=v,true)});
function node(key,dataset={}) {
 if(nodes.has(key))return nodes.get(key);
 const classes=new Set(),handlers={};
 const n={id:key.startsWith('#')?key.slice(1):key,dataset,textContent:'',innerHTML:'',style:{},handlers,
 classList:{toggle:(k,on)=>{if(on??!classes.has(k))classes.add(k);else classes.delete(k);},add:k=>classes.add(k),remove:k=>classes.delete(k),contains:k=>classes.has(k)},
 addEventListener:(k,f)=>{(handlers[k]??=[]).push(f);},setAttribute(){},focus(){},getContext:()=>context,
 click:async()=>{for(const f of handlers.click||[])await f({});},clientWidth:1280,clientHeight:800,width:1280,height:800};
 nodes.set(key,n);return n;
}
const scenarios=Object.keys(SCENARIOS).map(k=>node('scenario:'+k,{scenario:k}));
const planes=['beaufighter','spitfire','mosquito'].map(type=>node('plane:'+type,{type}));
const diffs=['easy','normal','ace'].map(diff=>node('diff:'+diff,{diff}));
const retries=['practice-coast','retry-coast','retry-coast-pause'].map(id=>node('#'+id,{raidStart:'coast'}));
globalThis.document={querySelector:node,querySelectorAll:s=>s==='[data-scenario]'?scenarios:s==='.plane'?planes:s==='.diff button'?diffs:s==='[data-raid-start]'?retries:[],addEventListener(){},createElement:()=>node('canvas')};
globalThis.window={addEventListener(){},innerWidth:1280,innerHeight:800,devicePixelRatio:1};
globalThis.localStorage={getItem:k=>stored.get(k)??null,setItem:(k,v)=>stored.set(k,String(v))};
let source=await readFile(new URL('../js/main.js',import.meta.url),'utf8');
source=source.slice(0,source.indexOf('const game = new Game();'))+'\nexport { Game };';
source=source.replaceAll(/from '(\.\/[^']+)'/g,(_,p)=>`from '${new URL('../js/'+p.slice(2),import.meta.url).href}'`);
const {Game}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const g=new Game(),models=buildModels();
for(const [key,type] of Object.entries(TYPES))type.geom=models.aircraft[key];
g.models=models;g.input={pad:null,mouse:{locked:false},lock(){},unlock(){}};
g.audio={ui(){},radio(){},voice(){},stopVoice(){},async init(){}};g.ps={n:0,out:[],fill:()=>0};g.navFocus=()=>{};
g.hud=Object.assign(Object.create(HUD.prototype),{world:null,g:context,c:node('#hud'),msgs:[],feed:[],center:null,W:1280,H:800,dpr:1,mapCanvas:{}});
g.R=new Proxy({meshes:{},vp:new Float32Array(16),planes:new Float32Array(20),
 addMesh(name,mesh,cap,stat=false){assert.ok(mesh,name);return this.meshes[name]={name,stat,cap};},
 setInstances(mesh,data,n){assert.ok(mesh,'instance mesh exists');for(let i=0;i<n*8;i++)assert.ok(Number.isFinite(data[i]),'finite render transform');},drawMesh(mesh){assert.ok(mesh);}}, {get:(o,k)=>o[k]??(()=>{})});
g.R.vp[0]=g.R.vp[5]=g.R.vp[10]=g.R.vp[15]=1;
g.streamScenery=()=>{};g.fillClouds=()=>0;g.fillTracers=()=>0;g.cloudWhite=()=>0;g.cloudFar=0;g.cloudData=new Float32Array(0);
g.selectWorld=key=>{g.world=new World({scenario:key});g.hud.world=g.world;g.staticMeshes=null;g.batches=new Map();g.registerMeshes();};
g.state='title';g.setupUI();
for(const scenario of scenarios) {
 await scenario.click();const key=scenario.dataset.scenario,spec=SCENARIOS[key];
 assert.equal(g.selScenario,key);assert.equal(stored.get('scramble.scenario'),key);
 assert.equal(node('#title .lede').textContent,spec.brief);
 assert.equal(node('#operation-card').classList.contains('hidden'),['channel','factory'].includes(key));
 assert.equal(retries[0].classList.contains('hidden'),key==='channel');
 await node('#go').click();assert.equal(g.state,'play');assert.equal(g.world.scenario,key);
 if(spec.type)assert.equal(g.sim.player.type.key,spec.type);
 for(let i=0;i<3;i++)g.sim.step(SIM_DT);
 if(key==='norway'){g.sim.player.ctl.bomb=true;g.sim.weapons(g.sim.player,SIM_DT);g.sim.player.ctl.bomb=false;}
 g.present();
 drawn.length=0;g.drawHud(1/60);g.render(1/60);
 if(spec.type) {
   if(key!=='factory')assert.ok(drawn.includes(spec.title),'scenario title reaches HUD');
   const m=g.sim.mission;m.finish(true,'Menu integration test.');g.endGame(g.sim.playerTeam);
   assert.ok(!node('#end .stats').innerHTML.includes('undefined'));
   assert.ok(!node('#end .stats').innerHTML.includes('NaN'));
   if(key!=='factory')assert.ok(stored.has(`scramble.raidBest.${key}.normal.full`),'scenario-specific personal best');
   await retries[1].click();assert.equal(g.state,'play');assert.equal(g.sim.mission.quickStart,true);
   assert.equal(g.sim.mission.complete,false);assert.equal(g.sim.mission.playerDrops,0);
   g.paused=true;await retries[2].click();assert.equal(g.paused,false);assert.equal(g.sim.mission.quickStart,true);
 }
 g.state='title';
}
console.log('PASS: all scenario menus, aircraft selection, real HUD/render orchestration, debriefs, separate records and pause/result retries');
