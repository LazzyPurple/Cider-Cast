import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Evaluate the actual plugin without Cider's DOM or the private connection token.
const source = readFileSync(new URL('./plugin.js', import.meta.url), 'utf8')
  .replace(/^import .+ from .+;\r?\n/gm, '').replace('export default {', 'const plugin = {');
function requestWith(fetch, signal = AbortSignal, connection = {getToken:async()=>'test-only',reset(){}}) {
  return runInNewContext(source + '\nrequest;', {
    fetch, AbortSignal: signal, getConnection: () => connection, release: {author:'test',repo:'https://github.com/test/test'}, VERSION: '1.0.0-rc.2',
    createAudioSettings: () => ({}), HTMLElement: class {}, createOutputControl: () => ({}),
  });
}

test('la découverte froide répond après quatre secondes sans être annulée par le panneau', async () => {
  const request = requestWith((url, options) => new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(options.signal.reason); };
    const timer = setTimeout(() => {
      options.signal.removeEventListener('abort', abort);
      resolve({ ok: true, json: async () => ({ devices: [{ id: 'cast:pair' }] }) });
    }, 4200);
    options.signal.addEventListener('abort', abort, { once: true });
  }));
  const results = await Promise.all([request('/devices'), request('/devices/refresh', {})]);
  for (const result of results) assert.equal(result.devices[0].id, 'cast:pair');
});

test('délais par commande conservés et vrai timeout de recherche expliqué en français', async () => {
  const deadlines = [], methods = [];
  const request = requestWith(async (url, options) => {
    methods.push(options.method);
    return { ok: true, json: async () => ({}) };
  }, { timeout(ms) { deadlines.push(ms); return {}; } });
  for (const [route, body] of [['/status'], ['/start', {}], ['/stop?id=one', {}], ['/recover', {}], ['/devices'], ['/devices/refresh', {}]]) await request(route, body);
  assert.deepEqual(deadlines, [4000, 45000, 15000, 12000, 10000, 10000]);
  assert.deepEqual(methods, ['GET', 'POST', 'POST', 'POST', 'GET', 'POST']);
  const timeout = requestWith(async () => { const error = new Error('signal timed out'); error.name = 'TimeoutError'; throw error; });
  await assert.rejects(timeout('/devices'), /recherche des appareils.*Actualiser/);
  await assert.rejects(timeout('/status'), /signal timed out/);
});

test('réglages natifs du plugin déclarés et texte des sorties inséré sans HTML', () => {
 assert.match(source, /SettingsElement: 'marshall-isolated-settings'/);
 assert.match(source, /option.textContent = output.name/);
 assert.match(source, /customElements.define\('marshall-isolated-settings'/);
});

test('Cider Cast : nom neutre, accent natif et accès aux réglages sans couleur imposée', () => {
 assert.match(source, /name: 'Cider Cast'/);
 assert.match(source, /var\(--primary, var\(--q-primary, currentColor\)\)/);
 assert.doesNotMatch(source, /#bd8bfa|rgba\(161,100,235/);
 assert.match(source, /data-settings aria-label=\"Réglages de Cider Cast\"/);
 assert.match(source, /document.createElement\('marshall-isolated-settings'\)/);
});

test('connexion du service : jeton seulement en en-tete, refus invalide l association et panne expliquee', async () => {
 let reset=0;
 const request=requestWith(async(url,options)=>{assert.ok(!url.includes('test-only'));assert.equal(options.headers['X-Marshall-Token'],'test-only');return {ok:false,status:403,json:async()=>({error:'Acces refuse'})};},AbortSignal,{getToken:async()=>'test-only',reset(){reset++;}});
 await assert.rejects(request('/status'),/connexion au service a changé/);assert.equal(reset,1);
 await assert.rejects(requestWith(async()=>{throw new TypeError('Failed to fetch')})('/status'),/service Windows ne répond pas/);
});
