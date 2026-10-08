import assert from 'node:assert/strict'
import { test } from 'node:test'
import { proRequest, uploadResolution } from '../src/lib/pro-api.ts'
import { ProRequestError, reservationRejected } from '../src/lib/pro-feedback.ts'

test('shared API transport preserves typed definitive rejection, uncertainty, expiry, and caller cancellation',async()=>{
  const originalFetch=globalThis.fetch
  let response=new Response('{}'),expired=0,seen:RequestInit|undefined
  globalThis.fetch=async(_input,init)=>{seen=init;return response}
  const call=(signal=new AbortController().signal)=>proRequest('/test',{csrf:'test-only',signal,body:{operationId:'fixture'},errors:{storage_limit:'full'},onExpired(){expired++}})
  try{
    await call()
    assert.ok(seen)
    assert.equal(seen.credentials,'include');assert.equal(seen.cache,'no-store')
    assert.equal((seen.headers as Record<string,string>)['x-csrf-token'],'test-only')
    response=Response.json({error:'storage_limit'},{status:429,headers:{'retry-after':'60'}})
    await assert.rejects(call(),error=>error instanceof ProRequestError&&error.status===429&&error.code==='storage_limit'&&reservationRejected(error)&&error.message.includes('1분'))
    response=Response.json({error:'upstream_unavailable'},{status:503})
    await assert.rejects(call(),error=>error instanceof ProRequestError&&!reservationRejected(error))
    response=new Response('{}',{status:401})
    await assert.rejects(call(),error=>error instanceof ProRequestError&&error.status===401)
    assert.equal(expired,1)
    response=new Response('{}')
    await assert.rejects(call(AbortSignal.abort()),{name:'AbortError'})
    globalThis.fetch=async()=>{throw new TypeError('Connection lost')}
    await assert.rejects(call(),error=>error instanceof TypeError&&!reservationRejected(error))
  }finally{globalThis.fetch=originalFetch}
})

test('only authoritative upload states complete or release retry state',()=>{
  assert.equal(uploadResolution('available'),'complete')
  for(const state of ['failed','cancelled','revoked','expired'])assert.equal(uploadResolution(state),'ended')
  for(const state of ['reserved','writing','not_found','','unknown'])assert.equal(uploadResolution(state),'pending')
})
