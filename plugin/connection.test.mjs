import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from './connection.js';
const token = 'a'.repeat(64), replacement = 'b'.repeat(64);
const store = () => { const map = new Map(); return {getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)}; };
const response = data => ({ok:true,text:async()=>JSON.stringify(data)});

test('association locale : aucun secret public, fichier installe puis cache apres mise a jour Marketplace', async () => {
  const storage=store();let calls=0;
  const first=createConnection(async (url,options)=>{calls++;assert.equal(options.cache,'no-store');assert.equal(String(url),'http://127.0.0.1:123/plugins/local.marshall-cast/service-connection.json');return response({schema:1,token});},storage,'http://127.0.0.1:123/plugins/local.marshall-cast/service-connection.json');
  assert.deepEqual(await Promise.all([first.getToken(),first.getToken()]),[token,token]);assert.equal(calls,1);
  const upgraded=createConnection(async()=>({ok:false,status:404}),storage,'local');assert.equal(await upgraded.getToken(),token);
  const reinstalled=createConnection(async()=>response({schema:1,token:replacement}),storage,'local');assert.equal(await reinstalled.getToken(),replacement);
  reinstalled.reset();const reset=createConnection(async()=>({ok:false}),storage,'local');await assert.rejects(reset.getToken(),/Installez le service/);
});

test('association refusee si invalide ou trop grosse ; absence guidee ; aucun secret affiche', async () => {
  for(const data of [{schema:2,token},{schema:1,token:'invalid'},null]){
    const connection=createConnection(async()=>response(data),store(),'local');await assert.rejects(connection.getToken(),e=>/Connexion locale invalide/.test(e.message)&&!e.message.includes(token));
  }
  await assert.rejects(createConnection(async()=>({ok:true,text:async()=> 'x'.repeat(1025)}),store(),'local').getToken(),/invalide/);
  await assert.rejects(createConnection(async()=>({ok:false}),store(),'local').getToken(),/Installez le service/);
});

test('stockage indisponible : association via fichier conservee ; une installation ulterieure est relue', async () => {
  let installed=false;
  const connection=createConnection(async()=>installed?response({schema:1,token}):({ok:false}),undefined,'local');
  await assert.rejects(connection.getToken(),/Installez/);installed=true;assert.equal(await connection.getToken(),token);
});
