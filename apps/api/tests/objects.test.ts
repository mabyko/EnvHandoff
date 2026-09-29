import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Objects } from '../src/objects.ts'

for(const action of ['cancel','timeout'] as const)test(action+' while the object is opening closes the eventual file handle and settles zero once',{timeout:2000},async t=>{
 if(action==='timeout')t.mock.timers.enable({apis:['setTimeout']})
 const root=await fs.mkdtemp(join(tmpdir(),'envhandoff-object-')),id=randomUUID()
 t.after(()=>fs.rm(root,{recursive:true,force:true}))
 await fs.writeFile(join(root,id),new Uint8Array([1,2,3]))
 let opened!:()=>void,release!:()=>void,closed!:()=>void
 const started=new Promise<void>(r=>{opened=r}),gate=new Promise<void>(r=>{release=r}),finished=new Promise<void>(r=>{closed=r})
 const original=fs.open
 let file:Awaited<ReturnType<typeof fs.open>>|undefined
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
  file=await original(...args)
  const close=file.close.bind(file)
  t.mock.method(file,'close',async()=>{await close();closed()})
  opened();await gate;return file
 })
 syncBuiltinESMExports()
 t.after(async()=>{release();await file?.close();t.mock.restoreAll();syncBuiltinESMExports()})
 const charges:number[]=[]
 const stream=await new Objects(root).read(id,3,async bytes=>{charges.push(bytes)})
 const reader=stream.getReader(),pending=reader.read()
 const outcome=action==='timeout'?assert.rejects(pending,/download_timeout/):pending
 await started
 if(action==='cancel'){await reader.cancel();assert.deepEqual(await outcome,{value:undefined,done:true})}
 else{t.mock.timers.tick(120_000);await outcome}
 release();await finished
 assert.equal(file!.fd,-1,'file opened after cancellation must still be closed')
 assert.deepEqual(charges,[0])
})

test('download deadline is absolute, charges consumed bytes once and clears its timer on every exit',async t=>{
 const root=await fs.mkdtemp(join(tmpdir(),'envhandoff-deadline-')),id=randomUUID(),size=256*1024
 t.after(()=>fs.rm(root,{recursive:true,force:true}))
 await fs.writeFile(join(root,id),new Uint8Array(size))
 for(const exit of ['idle timeout','active timeout','cancel','EOF'] as const)await t.test(exit,async t=>{
  t.mock.timers.enable({apis:['setTimeout']})
  const clear=t.mock.method(globalThis,'clearTimeout'),charges:number[]=[]
  const reader=(await new Objects(root).read(id,size,async bytes=>{charges.push(bytes)})).getReader()
  t.after(()=>reader.cancel().catch(()=>{}))
  let consumed=0
  if(exit==='EOF'){
   for(;;){const chunk=await reader.read();if(chunk.done)break;consumed+=chunk.value.byteLength}
  }else if(exit!=='idle timeout'){
   consumed+=(await reader.read()).value!.byteLength
   t.mock.timers.tick(60_000)
   if(exit==='cancel')await reader.cancel()
   else consumed+=(await reader.read()).value!.byteLength
  }
  if(exit.endsWith('timeout')){
   t.mock.timers.tick(exit==='idle timeout'?119_999:59_999)
   assert.deepEqual(charges,[]);assert.equal(clear.mock.callCount(),0)
   t.mock.timers.tick(1)
   assert.equal(clear.mock.callCount(),1)
   await assert.rejects(reader.read(),/download_timeout/)
  }
  t.mock.timers.tick(120_000)
  assert.deepEqual(charges,[consumed]);assert.equal(clear.mock.callCount(),1)
  if(exit==='EOF'||exit==='cancel')assert.deepEqual(await reader.read(),{value:undefined,done:true})
 })
})

test('consumer cancellation racing timeout or EOF settlement never settles twice',async t=>{
 const root=await fs.mkdtemp(join(tmpdir(),'envhandoff-settlement-')),id=randomUUID()
 t.after(()=>fs.rm(root,{recursive:true,force:true}))
 await fs.writeFile(join(root,id),new Uint8Array([1]))
 for(const exit of ['timeout','EOF'] as const)await t.test(exit,async t=>{
  t.mock.timers.enable({apis:['setTimeout']})
  let release!:()=>void,started!:()=>void,finished!:()=>void
  const gate=new Promise<void>(r=>{release=r}),settling=new Promise<void>(r=>{started=r}),settled=new Promise<void>(r=>{finished=r}),charges:number[]=[]
  const reader=(await new Objects(root).read(id,1,async bytes=>{charges.push(bytes);started();await gate;finished()})).getReader()
  t.after(()=>{release();return reader.cancel().catch(()=>{})})
  if(exit==='EOF')assert.equal((await reader.read()).value!.byteLength,1)
  else t.mock.timers.tick(120_000)
  await settling;await reader.cancel();release();await settled
  t.mock.timers.tick(120_000)
  assert.deepEqual(await reader.read(),{value:undefined,done:true})
  assert.deepEqual(charges,[exit==='EOF'?1:0])
 })
})
