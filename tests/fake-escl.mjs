// SPDX-License-Identifier: GPL-3.0-or-later
// A pretend network scanner for the tests: answers Bonjour questions for
// "_uscan._tcp" like a real printer does, and speaks enough eSCL over HTTP
// to scan one page (a small JPEG made by the caller).

import dgram from 'node:dgram';
import http from 'node:http';

function name(n) {
  return Buffer.concat([...n.split('.').filter(Boolean).map((l) => Buffer.concat([Buffer.from([Buffer.byteLength(l)]), Buffer.from(l)])), Buffer.from([0])]);
}

function record(owner, type, data) {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(1, 2);
  head.writeUInt32BE(120, 4);
  head.writeUInt16BE(data.length, 8);
  return Buffer.concat([name(owner), head, data]);
}

function reply({ instance, host, address, port, model }) {
  const full = `${instance}._uscan._tcp.local`;
  const srv = Buffer.concat([Buffer.from([0, 0, 0, 0, port >> 8, port & 255]), name(host)]);
  const txt = Buffer.concat([`rs=eSCL`, `ty=${model}`, 'pdl=image/jpeg'].map((e) => Buffer.concat([Buffer.from([Buffer.byteLength(e)]), Buffer.from(e)])));
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(1, 6);
  header.writeUInt16BE(3, 10);
  return Buffer.concat([
    header,
    record('_uscan._tcp.local', 12, name(full)),
    record(full, 33, srv),
    record(full, 16, txt),
    record(host, 1, Buffer.from(address.split('.').map(Number))),
  ]);
}

/**
 * Starts the pretend scanner. `jpeg` is what a scan returns. Answers Bonjour
 * on `mdnsPort` (5353 unless that's taken) and HTTP on a free port.
 */
export async function makeFakeEscl({ jpeg, model = 'HP OfficeJet Pro 9010', address = '127.0.0.1', mdnsPort = 5353 }) {
  const log = [];
  let busyOnce = true;
  // what's left in the job: one page from the glass, or a stack of sheets from the feeder
  let left = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      log.push({ method: req.method, url: req.url, body });
      if (req.url === '/eSCL/ScannerCapabilities') {
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end(`<?xml version="1.0"?><scan:ScannerCapabilities xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03"><scan:Platen><scan:PlatenInputCaps><scan:MaxWidth>2550</scan:MaxWidth><scan:MaxHeight>3508</scan:MaxHeight><scan:SettingProfiles><scan:SettingProfile><scan:SupportedResolutions><scan:DiscreteResolutions><scan:DiscreteResolution><scan:XResolution>100</scan:XResolution><scan:YResolution>100</scan:YResolution></scan:DiscreteResolution><scan:DiscreteResolution><scan:XResolution>300</scan:XResolution><scan:YResolution>300</scan:YResolution></scan:DiscreteResolution></scan:DiscreteResolutions></scan:SupportedResolutions></scan:SettingProfile></scan:SettingProfiles></scan:PlatenInputCaps></scan:Platen><scan:Adf><scan:AdfSimplexInputCaps><scan:MaxWidth>2550</scan:MaxWidth><scan:MaxHeight>4200</scan:MaxHeight><scan:SettingProfiles><scan:SettingProfile><scan:SupportedResolutions><scan:DiscreteResolutions><scan:DiscreteResolution><scan:XResolution>200</scan:XResolution><scan:YResolution>200</scan:YResolution></scan:DiscreteResolution></scan:DiscreteResolutions></scan:SupportedResolutions></scan:SettingProfile></scan:SettingProfiles></scan:AdfSimplexInputCaps><scan:AdfDuplexInputCaps><scan:MaxWidth>2550</scan:MaxWidth><scan:MaxHeight>4200</scan:MaxHeight></scan:AdfDuplexInputCaps></scan:Adf></scan:ScannerCapabilities>`);
      } else if (req.method === 'POST' && req.url === '/eSCL/ScanJobs') {
        const feeder = /<pwg:InputSource>Feeder</.test(body);
        // three sheets in the feeder: six pages when both sides are scanned
        left = feeder ? (/<scan:Duplex>true</.test(body) ? 6 : 3) : 1;
        res.writeHead(201, { Location: `http://${address}:${server.address().port}/eSCL/ScanJobs/job-${log.length}` });
        res.end();
      } else if (/\/eSCL\/ScanJobs\/job-\d+\/NextDocument$/.test(req.url)) {
        // real scanners say they're busy while the head is still moving
        if (!left) { res.writeHead(404); res.end(); return; }
        if (busyOnce) { busyOnce = false; res.writeHead(503); res.end(); return; }
        busyOnce = true;
        left--;
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        res.end(jpeg);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise((r) => server.listen(0, address, r));
  const port = server.address().port;

  const mdns = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  await new Promise((resolve, reject) => {
    mdns.once('error', reject);
    mdns.bind(mdnsPort, () => {
      try { mdns.addMembership('224.0.0.251'); } catch { /* answering direct questions still works */ }
      try { mdns.setMulticastLoopback(true); } catch { /* fine */ }
      resolve();
    });
  });
  mdns.on('message', (msg, from) => {
    if (!msg.includes(Buffer.from('_uscan'))) return;
    mdns.send(reply({ instance: 'Office printer', host: 'fake-printer.local', address, port, model }), from.port, from.address);
  });

  return {
    log,
    mdnsPort: mdns.address().port,
    close: () => new Promise((r) => { mdns.close(); server.close(r); }),
  };
}
