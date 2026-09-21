"use strict";
// The download optimizations: resuming a broken piece from its received bytes, spreading
// pieces over nodes by measured speed, and growing sub-chunks with the measured speed.
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const SOURCE=fs.existsSync(path.join(__dirname,"../shared/range-core.js"))?path.join(__dirname,"../shared"):path.join(__dirname,"../src");
function load(){
  const context=vm.createContext({URL,AbortController,DOMException,Response,ReadableStream,Headers,Uint8Array,Promise,setTimeout,clearTimeout,performance,console});
  context.globalThis=context;
  context.__now=1e12;
  vm.runInContext("Date.now=()=>globalThis.__now;",context);
  for(const file of ["range-core.js","cdn-resolver.js","idm-downloader.js"])vm.runInContext(fs.readFileSync(path.join(SOURCE,file),"utf8"),context,{filename:file});
  return {core:context.__BILI_RANGE_CORE__,cdn:context.__BILI_CDN_RESOLVER_FACTORY__,idm:context.__BILI_IDM_DOWNLOADER_FACTORY__,advance:ms=>{context.__now+=ms;}};
}
const mediaUrl=host=>`https://${host}/upgcxcode/00/00/1/1-1-30080.m4s?deadline=1&os=x`;
const pattern=(start,length)=>{const bytes=new Uint8Array(length);for(let i=0;i<length;i+=1)bytes[i]=(start+i)%251;return bytes;};
const rangeOf=init=>{const [,start,end]=/bytes=(\d+)-(\d+)/.exec(init.headers.Range).map(Number);return {start,end,length:end-start+1};};
const ok=(start,end,total)=>new Response(pattern(start,end-start+1),{status:206,headers:{"Content-Range":`bytes ${start}-${end}/${total}`}});

test("a broken transfer is resumed from its received bytes instead of downloaded again",{timeout:30000},async()=>{
  const {idm}=load();
  const BREAKS="upos-sz-mirrorali.bilivideo.com",RESCUES="upos-sz-mirrorhw.bilivideo.com";
  const TOTAL=8388608;
  const requests=[];
  const nativeFetch=async(url,init)=>{
    const host=new URL(url).hostname;
    const {start,end}=rangeOf(init);
    requests.push({host,start,end});
    if(host===BREAKS){
      // Sends the first 96 KiB, then the connection breaks.
      let sent=0;
      const body=new ReadableStream({pull(controller){
        if(sent>=96*1024){controller.error(new Error("连接中断"));return;}
        controller.enqueue(pattern(start+sent,32*1024));
        sent+=32*1024;
      }});
      return new Response(body,{status:206,headers:{"Content-Range":`bytes ${start}-${end}/${TOTAL}`}});
    }
    return ok(start,end,TOTAL);
  };
  const only=[mediaUrl(BREAKS),mediaUrl(RESCUES)];
  const resolver={urls:()=>only,ordered:()=>only,rescueCandidates:()=>only.slice(1),rangeCandidates:()=>only,allows:()=>true,success(){},failure(){},speed:()=>0};
  const downloader=idm.createDownloader({getSettings:()=>({concurrency:4}),nativeFetch});
  // One piece only: the whole range is one 512 KiB sub-chunk.
  const range={start:1000,end:1000+512*1024-1,length:512*1024};
  const result=await downloader.downloadRange(range,resolver,{parallel:true,kind:"video",maxConcurrency:1});
  assert.equal(result.bytes.length,range.length);
  assert.ok(result.bytes.every((value,i)=>value===(range.start+i)%251),"spliced bytes are positioned correctly");
  const rescue=requests.filter(item=>item.host===RESCUES);
  assert.equal(rescue.length,1);
  assert.equal(rescue[0].start,range.start+96*1024,"the rescue request asked only for the missing tail");
  assert.equal(rescue[0].end,range.end);
});

test("pieces are spread over nodes by measured speed",{timeout:30000},async()=>{
  const {cdn,idm}=load();
  const FAST="upos-sz-mirrorali.bilivideo.com",SLOW="upos-sz-mirrorhw.bilivideo.com";
  const counts=new Map();
  const nativeFetch=async(url,init)=>{
    const host=new URL(url).hostname;
    counts.set(host,(counts.get(host)||0)+1);
    const {start,end}=rangeOf(init);
    return ok(start,end,67108864);
  };
  const downloader=idm.createDownloader({getSettings:()=>({concurrency:32,mode:"custom",customHosts:[FAST,SLOW]}),nativeFetch});
  const resolver=cdn.createResolver({baseUrl:mediaUrl(FAST)},()=> "custom",null,()=>[FAST,SLOW]);
  // Health as if the fast node had been measured nine times faster.
  resolver.success(mediaUrl(FAST),9*1024*1024);
  resolver.success(mediaUrl(SLOW),1*1024*1024);
  const range={start:0,end:2*1024*1024-1,length:2*1024*1024};
  const result=await downloader.downloadRange(range,resolver,{parallel:true,kind:"video"});
  assert.equal(result.bytes.length,range.length);
  assert.ok((counts.get(FAST)||0)>=(counts.get(SLOW)||0)*2,
    `the fast node carries most pieces: fast ${counts.get(FAST)} vs slow ${counts.get(SLOW)}`);
  assert.ok((counts.get(SLOW)||0)>=1,"the slow node keeps a floor share");
});

test("sub-chunks grow with the measured connection speed, but a range keeps at least four pieces",{timeout:30000},async()=>{
  const {idm}=load();
  const HOST="upos-sz-mirrorali.bilivideo.com";
  let requests=[];
  const nativeFetch=async(url,init)=>{
    const {start,end}=rangeOf(init);
    requests.push(end-start+1);
    return ok(start,end,67108864);
  };
  const only=[mediaUrl(HOST)];
  const resolver={urls:()=>only,ordered:()=>only,rescueCandidates:()=>only,rangeCandidates:()=>only,allows:()=>true,success(){},failure(){},speed:()=>0};
  const downloader=idm.createDownloader({getSettings:()=>({concurrency:32}),nativeFetch});
  // The first range is measured with 64 KiB chunks (instant responses look very fast here).
  const first={start:0,end:2*1024*1024-1,length:2*1024*1024};
  await downloader.downloadRange(first,resolver,{parallel:true,kind:"video"});
  const firstCounts=requests.length;
  assert.ok(firstCounts>=16,`the unmeasured range splits small: ${firstCounts} pieces`);
  requests=[];
  const second={start:4*1024*1024,end:6*1024*1024-1,length:2*1024*1024};
  await downloader.downloadRange(second,resolver,{parallel:true,kind:"video"});
  assert.ok(requests.length<firstCounts,`the measured range uses larger pieces: ${requests.length} < ${firstCounts}`);
  assert.ok(requests.length>=4,`the spread over nodes keeps at least four pieces: ${requests.length}`);
  assert.ok(Math.max(...requests)<=1024*1024,"a sub-chunk never exceeds 1 MiB");
});

test("a resolver reports the measured speed of an address",()=>{
  const {cdn}=load();
  const resolver=cdn.createResolver({baseUrl:mediaUrl("upos-sz-mirrorali.bilivideo.com")},()=> "mainland");
  assert.equal(resolver.speed(mediaUrl("upos-sz-mirrorali.bilivideo.com")),0);
  resolver.success(mediaUrl("upos-sz-mirrorali.bilivideo.com"),5000000);
  assert.equal(resolver.speed(mediaUrl("upos-sz-mirrorali.bilivideo.com")),5000000);
});
