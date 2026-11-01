const storageKey = 'cider-cast-service-connection-v1';
const valid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function createConnection(fetcher, storage, url) {
  let token, pending;
  async function load() {
    let response;
    try { response = await fetcher(url, { cache: 'no-store', signal: AbortSignal.timeout(3000) }); }
    catch { /* A Marketplace update may remove the provisioned file; keep the local association. */ }
    if (response?.ok) {
      const text = await response.text();
      if (text.length > 1024) throw new Error('Connexion locale invalide. Réinstallez le service Windows.');
      let data;
      try { data = JSON.parse(text); } catch { throw new Error('Connexion locale invalide. Réinstallez le service Windows.'); }
      if (data?.schema !== 1 || !valid(data.token)) throw new Error('Connexion locale invalide. Réinstallez le service Windows.');
      token = data.token;
      try { storage.setItem(storageKey, token); } catch { /* The provisioned file remains available without storage. */ }
    } else {
      try { token = storage.getItem(storageKey); } catch { token = null; }
    }
    if (!valid(token)) { token = null; throw new Error('Installez le service audio Windows pour commencer.'); }
    return token;
  }
  return {
    async getToken() {
      if (token) return token;
      if (!pending) pending = load().finally(() => { pending = null; });
      return pending;
    },
    reset() { token = null; try { storage.removeItem(storageKey); } catch {} },
  };
}

let connection;
export function getConnection() {
  let storage;
  try { storage = window.localStorage; } catch { /* The installed connection file also works without browser storage. */ }
  return connection ??= createConnection(fetch, storage, new URL('./service-connection.json', import.meta.url));
}
