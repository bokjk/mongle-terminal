import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HostStore, type PersistedHost } from '../../packages/storage/index.js';

test('history deletion and settings commit roll back together on a database error',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mongle-storage-test-')),store=new HostStore(dir);
  t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
  const state:PersistedHost={schemaVersion:1,hostId:randomUUID(),settings:{name:'PC',recordHistory:true,scrollback:5000},groups:[],terminals:[]};
  const id=randomUUID(),generation=randomUUID();
  store.save(state);store.saveSnapshot(id,generation,{kind:'presentation-v1',version:'test',data:'retained output',cols:80,rows:24,modes:{}});
  // A SQLite trigger gives a deterministic real transactional failure without
  // filling a user's disk or changing filesystem permissions.
  (store as any).db.exec("CREATE TRIGGER refuse_history_delete BEFORE DELETE ON snapshots BEGIN SELECT RAISE(ABORT, 'simulated storage error'); END;");
  assert.throws(()=>store.save({...state,settings:{...state.settings,recordHistory:false}},'all'));
  assert.equal(store.load()!.settings.recordHistory,true);
  assert.equal(store.getSnapshot(id,generation)!.data,'retained output');
  (store as any).db.exec('DROP TRIGGER refuse_history_delete;');
  store.save({...state,settings:{...state.settings,recordHistory:false}},'all');
  assert.equal(store.load()!.settings.recordHistory,false);assert.equal(store.getSnapshot(id,generation),undefined);
});

test('opening a newer schema refuses downgrade without resetting its version',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'mongle-schema-test-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const store=new HostStore(dir);(store as any).db.exec('PRAGMA user_version=2');store.close();
  assert.throws(()=>new HostStore(dir),/더 새 버전/);
});
