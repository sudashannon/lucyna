const test=require('node:test'),assert=require('node:assert/strict');
const {windowShape,unionRegions}=require('../src/pet/shape.cjs');
const hit=(regions,x,y)=>regions.some(r=>x>=r.x&&x<r.x+r.width&&y>=r.y&&y<r.y+r.height);
test('native hit regions read only the selected atlas frame and reject invalid source coordinates',()=>{
 const bitmap=Buffer.alloc(8*4*4);for(let y=0;y<4;y++)for(let x=4;x<7;x++)bitmap[(y*8+x)*4+3]=255;
 const args={bitmap,width:8,height:4,image:{x:0,y:0,width:8,height:8},badge:{x:0,y:9,width:0,height:0},bounds:{width:8,height:10}};
 const a=windowShape({...args,source:{x:0,y:0,width:4,height:4}}),b=windowShape({...args,source:{x:4,y:0,width:4,height:4}});
 assert.equal(hit(a,2,2),false);assert.equal(hit(b,2,2),true);assert.equal(hit(b,7,2),false);
 assert.throws(()=>windowShape({...args,source:{x:6,y:0,width:4,height:4}}),/Invalid sprite source/);
});

test('a stable animated region contains every pose without filling transparent gaps',()=>{
 const bounds={width:12,height:10},poses=[[{x:2,y:1,width:3,height:5},{x:3,y:8,width:6,height:1}],[{x:5,y:2,width:3,height:4},{x:3,y:8,width:6,height:1}]];
 const union=unionRegions(poses,bounds);
 for(let y=0;y<bounds.height;y++)for(let x=0;x<bounds.width;x++)assert.equal(hit(union,x,y),poses.some(pose=>hit(pose,x,y)));
 assert.ok(union.length<15);assert.throws(()=>unionRegions(poses,{width:Infinity,height:10}),/Invalid/);
});
test('native shape preserves empty corners and transparent holes while including the status badge',()=>{
 const bitmap=Buffer.alloc(8*8*4);for(let y=1;y<7;y++)for(let x=2;x<6;x++)if(!(y===3&&x===3))bitmap[(y*8+x)*4+3]=255;
 const regions=windowShape({bitmap,width:8,height:8,image:{x:0,y:0,width:16,height:16},badge:{x:4,y:18,width:8,height:2},bounds:{width:16,height:20}});
 assert.equal(hit(regions,0,0),false);assert.equal(hit(regions,5,5),true);assert.equal(hit(regions,6,6),false);assert.equal(hit(regions,5,19),true);assert.equal(hit(regions,0,19),false);assert.ok(regions.length<15);
});
test('letterboxing and fractional layout stay inside bounds; invalid sender geometry cannot expand the clickable window',()=>{
 const bitmap=Buffer.alloc(4*8*4,255),args={bitmap,width:4,height:8,image:{x:0,y:0,width:20,height:16},badge:{x:5.5,y:18.1,width:9,height:1.9},bounds:{width:20,height:20}};
 const regions=windowShape(args);assert.equal(hit(regions,2,8),false);assert.equal(hit(regions,10,8),true);assert.ok(regions.every(r=>r.x>=0&&r.y>=0&&r.x+r.width<=20&&r.y+r.height<=20));assert.throws(()=>windowShape({...args,badge:{x:-10,y:1,width:2,height:1}}),/outside/);assert.throws(()=>windowShape({...args,image:{x:0,y:0,width:Infinity,height:16}}),/Invalid/);
});
