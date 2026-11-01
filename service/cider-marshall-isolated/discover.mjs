import mdns from 'multicast-dns';
import { isIPv4 } from 'node:net';
import os from 'node:os';

export async function discoverDevices(duration = 4000, createMdns = mdns, onDevices = () => {}) {
  const addresses = [...new Set(Object.values(os.networkInterfaces()).flat().filter(i => !i.internal && (i.family === 'IPv4' || i.family === 4)).map(i => i.address))];
  const clients = [];
  const records = new Map();
  const devices = () => {
    const found = [];
    for (const r of records.values()) {
      if (r.type !== 'TXT' || r.expires <= Date.now() || !r.name.toLowerCase().endsWith('._googlecast._tcp.local') || !Array.isArray(r.data)) continue;
      const txt = Object.fromEntries(r.data.filter(b => Buffer.isBuffer(b) || typeof b === 'string').map(b => { const s = b.toString(); const i = s.indexOf('='); return i > 0 ? [s.slice(0, i), s.slice(i + 1)] : ['', '']; }));
      const srv = records.get(`${r.name.toLowerCase()}/SRV`);
      const service = srv?.data;
      const address = typeof service?.target === 'string' ? records.get(`${service.target.toLowerCase()}/A`) : null;
      const host = address?.data;
      const name = typeof txt.fn === 'string' ? txt.fn.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 160) : '';
      if (!name || !srv || !address || srv.expires <= Date.now() || address.expires <= Date.now()) continue;
      if (isIPv4(host ?? '') && /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) && Number.isInteger(service.port) && service.port > 0 && service.port <= 65535) {
        const model = (txt.md ?? '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120);
        const id = /^[a-zA-Z0-9_-]{1,128}$/.test(txt.id ?? '') ? 'cast:' + txt.id.toLowerCase() : r.name.toLowerCase();
        found.push({ id, host, port: service.port, name, model, group: /google.cast.group|audio.group/i.test(model + ' ' + r.name) });
      }
    }
    return [...new Map(found.map(device => [device.id, device])).values()].sort((a, b) => a.name.localeCompare(b.name));
  };
  const response = packet => {
    for (const r of [...(packet.answers ?? []), ...(packet.additionals ?? [])]) {
      if (!['TXT', 'SRV', 'A'].includes(r.type) || typeof r.name !== 'string' || r.name.length > 255 || (r.ttl !== undefined && (!Number.isFinite(r.ttl) || r.ttl < 0))) continue;
      const key = `${r.name.toLowerCase()}/${r.type}`;
      if (r.ttl === 0) records.delete(key);
      else if (records.has(key) || records.size < 1024) records.set(key, { ...r, expires: Date.now() + Math.min(r.ttl ?? 120, 86400) * 1000 });
    }
    onDevices(devices());
  };
  let repeat, timer;
  try {
    // A wildcard outgoing interface can choose WSL instead of Wi-Fi on Windows.
    for (const address of addresses) {
      const dns = createMdns({ interface: address, bind: '0.0.0.0' });
      clients.push(dns); dns.on('response', response);
    }
    if (!clients.length) return [];
    await new Promise((resolve, reject) => {
      const failed = new Set();
      const query = () => { for (const dns of clients) if (!failed.has(dns)) dns.query({ questions: [{ name: '_googlecast._tcp.local', type: 'PTR' }] }); };
      timer = setTimeout(resolve, duration);
      for (const dns of clients) dns.on('error', () => {
        failed.add(dns);
        if (failed.size === clients.length) reject(new Error('Découverte réseau indisponible. Vérifiez la connexion Wi-Fi puis réessayez.'));
      });
      query();
      repeat = setInterval(query, 1000);
    });
    return devices();
  } finally { clearTimeout(timer); clearInterval(repeat); for (const dns of clients) dns.destroy(); }
}

export async function discover(target, localAddress, duration = 4000, createMdns = mdns) {
  const found = (await discoverDevices(duration, createMdns)).filter(device => device.id === target || device.name === target);
  if (found.length !== 1) throw new Error(found.length ? 'Nom Cast ambigu. Choisissez un appareil dans la liste.' : 'Appareil Cast introuvable sur le réseau. Actualisez la liste.');
  return found[0];
}
