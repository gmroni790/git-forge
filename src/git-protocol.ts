// Git smart-HTTP protocol layer: pkt-line framing, upload-pack (v0 + v2),
// receive-pack (v0). Pure functions over the Store + Buffers; no HTTP here.
// Pinned interfaces: ~/workspace/makefun/forge-specs/interfaces.md
// Wire exactness: ~/workspace/makefun/forge-specs/git-spec.md

import type { Store } from './store.ts';
import type { GitObject, Oid, Repo } from './types.ts';
import {
  buildPack,
  collectReachable,
  collectReachableDepth,
  parseCommit,
  parsePack,
  parseTag,
  parseTree,
} from './git-objects.ts';

export const ZERO_OID: Oid = '0'.repeat(40);

/** git's LARGE_PACKET_MAX: largest pkt-line including its 4-byte header. */
const PKT_LINE_MAX = 65520;
/** Largest pkt-line payload (length minus the 4-byte header). */
const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;
/** Largest pack payload in one sideband packet: 4 (header) + 1 (band) + data. */
const SIDEBAND_MAX_DATA = PKT_LINE_MAX - 5;

const HEX40 = /^[0-9a-f]{40}$/;
const HEX4 = /^[0-9a-fA-F]{4}$/;

function isOid(value: string): boolean {
  return HEX40.test(value);
}

// ---------------------------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------------------------

/** Encode one data packet: 4 lowercase-hex length bytes (payload + 4), then the payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX_PAYLOAD) {
    throw new Error(`pkt-line payload is ${data.length} bytes, over the ${PKT_LINE_MAX_PAYLOAD}-byte maximum`);
  }
  const header = (data.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'ascii'), data]);
}

/** Flush packet: '0000'. */
export const FLUSH: Buffer = Buffer.from('0000', 'ascii');
/** Delimiter packet: '0001'. */
export const DELIM: Buffer = Buffer.from('0001', 'ascii');

/**
 * Parse pkt-lines until flush/delim/response-end/end of buffer.
 * `lines` are the data payloads in order; `rest` is the bytes after the
 * terminating control packet (for receive-pack: the raw pack). Throws on
 * malformed framing (bad header, bad length, truncation, over-long packet).
 */
export function parsePktLines(buf: Buffer): { lines: Buffer[]; rest: Buffer } {
  const lines: Buffer[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('pkt-line truncated');
    const header = buf.subarray(off, off + 4).toString('ascii');
    if (!HEX4.test(header)) throw new Error('pkt-line bad header');
    const len = parseInt(header, 16);
    if (len === 0 || len === 1 || len === 2) {
      return { lines, rest: buf.subarray(off + 4) };
    }
    if (len < 4) throw new Error('pkt-line bad length');
    if (len > PKT_LINE_MAX) throw new Error('pkt-line too long');
    if (off + len > buf.length) throw new Error('pkt-line truncated');
    lines.push(buf.subarray(off + 4, off + len));
    off += len;
  }
  return { lines, rest: Buffer.alloc(0) };
}

/** Strip one trailing '\n' from a pkt-line payload, as text. */
function lineText(raw: Buffer): string {
  return raw.toString('utf8').replace(/\n$/, '');
}

/** Split a sideband payload into band-1 packets of at most SIDEBAND_MAX_DATA bytes. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let off = 0; off < pack.length; off += SIDEBAND_MAX_DATA) {
    const chunk = pack.subarray(off, off + SIDEBAND_MAX_DATA);
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// ref helpers
// ---------------------------------------------------------------------------------------------

function sortedRefs(repo: Repo): Array<[string, Oid]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function headOid(repo: Repo): Oid | null {
  return repo.refs.get(repo.headRef) ?? null;
}

/**
 * Peel a ref through tag objects to the first non-tag object, or null when the
 * ref does not point at a tag object (or the chain is broken/cyclic).
 */
function peelTag(store: Store, repo: Repo, oid: Oid): Oid | null {
  const first = store.getObject(repo, oid);
  if (!first || first.type !== 'tag') return null;
  const seen = new Set<Oid>([oid]);
  let info = parseTag(first.data);
  let target = info.object;
  while (info.type === 'tag') {
    if (seen.has(target)) return null;
    seen.add(target);
    const next = store.getObject(repo, target);
    if (!next || next.type !== 'tag') return null;
    info = parseTag(next.data);
    target = info.object;
  }
  return target;
}

// ---------------------------------------------------------------------------------------------
// advertisements (info/refs)
// ---------------------------------------------------------------------------------------------

const UPLOAD_CAPS = 'side-band-64k shallow thin-pack ofs-delta multi_ack_detailed';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta';

/** v0 advertisement for upload-pack or receive-pack, with the `# service=` preamble. */
export function advertisementV0(store: Store, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  const head = headOid(repo);
  let caps: string;
  if (service === 'git-upload-pack') {
    caps = head ? `symref=HEAD:${repo.headRef} ${UPLOAD_CAPS}` : UPLOAD_CAPS;
  } else {
    caps = RECEIVE_CAPS;
  }
  if (repo.refs.size === 0) {
    // Empty repository: the single capabilities^{} pseudo-ref line.
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  // Capabilities ride after a NUL on the FIRST ref line only.
  let capsPlaced = false;
  const firstLine = (text: string): string => {
    if (capsPlaced) return text;
    capsPlaced = true;
    return `${text}\0${caps}`;
  };
  if (head) {
    parts.push(pktLine(`${firstLine(`${head} HEAD`)}\n`));
  }
  for (const [name, oid] of sortedRefs(repo)) {
    parts.push(pktLine(`${firstLine(`${oid} ${name}`)}\n`));
    const peeled = peelTag(store, repo, oid);
    if (peeled) parts.push(pktLine(`${peeled} ${name}^{}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** v2 advertisement (upload-pack only): preamble + `version 2` + capability lines. */
export function advertisementV2(_store: Store, _repo: Repo): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    FLUSH,
    pktLine('version 2\n'),
    pktLine('fetch=shallow\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('object-format=sha1\n'),
    FLUSH,
  ]);
}

// ---------------------------------------------------------------------------------------------
// ls-refs (protocol v2)
// ---------------------------------------------------------------------------------------------

/** v2 ls-refs: peel, symrefs, unborn, server-side ref-prefix filtering. */
export function handleLsRefs(store: Store, repo: Repo, body: Buffer): Buffer {
  const head = parsePktLines(body);
  const command = head.lines.length ? lineText(head.lines[0]) : '';
  if (command !== 'command=ls-refs') throw new Error('expected command=ls-refs');
  const args = parsePktLines(head.rest);
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const raw of args.lines) {
    const line = lineText(raw);
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    // Unknown arguments are ignored.
  }
  const keep = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: string[] = [];
  const tip = headOid(repo);
  if (tip) {
    if (keep('HEAD')) {
      out.push(symrefs ? `${tip} HEAD symref-target:${repo.headRef}` : `${tip} HEAD`);
    }
  } else if (unborn && keep('HEAD')) {
    out.push(symrefs ? `unborn HEAD symref-target:${repo.headRef}` : 'unborn HEAD');
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const peeled = peelTag(store, repo, oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    out.push(line);
  }
  return Buffer.concat([...out.map((line) => pktLine(`${line}\n`)), FLUSH]);
}

// ---------------------------------------------------------------------------------------------
// fetch (v2 + v0 share the send-set computation)
// ---------------------------------------------------------------------------------------------

interface FetchParams {
  wants: Oid[];
  haves: Oid[];
  shallow: Oid[]; // the client's current shallow boundary
  depth: number | null; // absolute depth from the wanted tips, or null
}

interface FetchPlan {
  sendSet: Set<Oid>;
  shallowOut: Oid[]; // boundary commits of the sent pack (sorted)
  unshallowOut: Oid[]; // client shallow boundaries now interior (sorted)
  ackHaves: Oid[]; // haves the server holds
  pack: Buffer | null; // null when the send set is empty
}

/**
 * Reachability that stops at the client's shallow boundaries: a boundary
 * commit contributes itself + its tree/blobs, but not its parents. The client
 * holds the boundary commit shallowly, so its parents must NOT be treated as
 * held (a deepen fetch must deliver them).
 */
function collectReachableStopAt(
  getObject: (oid: Oid) => GitObject | null,
  tips: Oid[],
  stop: Set<Oid>,
): Set<Oid> {
  const out = new Set<Oid>();
  const stack: Oid[] = [...tips];
  while (stack.length) {
    const oid = stack.pop() as Oid;
    if (out.has(oid)) continue;
    const obj = getObject(oid);
    if (!obj) continue; // tolerate unknown haves
    out.add(oid);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      stack.push(info.tree);
      if (!stop.has(oid)) {
        for (const parent of info.parents) stack.push(parent);
      }
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '160000') continue; // gitlink: not followed
        stack.push(entry.oid);
      }
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return out;
}

/**
 * The exact send set: reachable(wants) [depth-limited] minus reachable(haves)
 * [shallow-aware]. Nothing held is re-sent; nothing reachable from a want is
 * missing. The pack is cached per repo version + send set (deterministic
 * bytes: objects sorted by oid, plain objects only, zlib level 6).
 */
function planFetch(store: Store, repo: Repo, params: FetchParams): FetchPlan {
  const getObject = (oid: Oid): GitObject | null => store.getObject(repo, oid);
  const wants = [...new Set(params.wants)].filter((oid) => isOid(oid) && store.hasObject(repo, oid));
  const haves = [...new Set(params.haves)].filter((oid) => isOid(oid));
  const shallowIn = new Set(params.shallow.filter((oid) => isOid(oid)));
  let included: Set<Oid>;
  let boundary: Set<Oid>;
  if (params.depth !== null) {
    const r = collectReachableDepth(getObject, wants, params.depth);
    included = r.included;
    boundary = r.shallow;
  } else {
    included = collectReachable(getObject, wants);
    boundary = new Set<Oid>();
  }
  const held = collectReachableStopAt(getObject, haves, shallowIn);
  const sendSet = new Set<Oid>([...included].filter((oid) => !held.has(oid)));
  // Only boundary commits actually sent are reported shallow; a boundary the
  // client already holds (with its parents) is not shallow for them.
  const shallowOut = [...boundary].filter((oid) => sendSet.has(oid)).sort();
  // A client shallow boundary is unshallowed when it is included and no longer
  // at the boundary (its parents are now included, or it is a root).
  const unshallowOut = [...shallowIn].filter((oid) => included.has(oid) && !boundary.has(oid)).sort();
  const ackHaves = haves.filter((oid) => store.hasObject(repo, oid));
  let pack: Buffer | null = null;
  if (sendSet.size > 0) {
    const key = `${repo.version}:${[...sendSet].sort().join(',')}`;
    const cached = repo.packCache.get(key);
    if (cached) {
      pack = cached;
    } else {
      const objects = [...sendSet].sort().map((oid) => {
        const obj = store.getObject(repo, oid) as GitObject;
        return { oid, type: obj.type, data: obj.data };
      });
      pack = buildPack(objects);
      repo.packCache.set(key, pack);
    }
  }
  return { sendSet, shallowOut, unshallowOut, ackHaves, pack };
}

/** Parse the v2 fetch argument section (after the delim) into fetch params. */
function parseFetchArgs(lines: Buffer[]): FetchParams {
  const wants: Oid[] = [];
  const haves: Oid[] = [];
  const shallow: Oid[] = [];
  let depth: number | null = null;
  for (const raw of lines) {
    const line = lineText(raw);
    if (line.startsWith('want ')) {
      const oid = line.slice(5).trim();
      if (isOid(oid)) wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (isOid(oid)) haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (isOid(oid)) shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
    // thin-pack, no-progress, ofs-delta, filter, deepen-since, deepen-not,
    // done, want-ref and unknown lines are accepted and ignored.
  }
  return { wants, haves, shallow, depth };
}

/**
 * v2 fetch. Response sections (each ending with flush, never 0002):
 * acknowledgments (only when haves were sent), shallow-info (only when there
 * is shallow/unshallow news), packfile (only when objects are sent — a
 * nothing-new fetch omits it entirely).
 */
export function handleFetchV2(store: Store, repo: Repo, body: Buffer): Buffer {
  const head = parsePktLines(body);
  const command = head.lines.length ? lineText(head.lines[0]) : '';
  if (command !== 'command=fetch') throw new Error('expected command=fetch');
  const args = parsePktLines(head.rest);
  const params = parseFetchArgs(args.lines);
  if (params.wants.length === 0) throw new Error('fetch with no wants');
  const plan = planFetch(store, repo, params);
  const parts: Buffer[] = [];
  if (params.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    if (plan.ackHaves.length > 0) {
      for (const oid of plan.ackHaves) parts.push(pktLine(`ACK ${oid}\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(pktLine('ready\n'));
    parts.push(FLUSH);
  }
  if (plan.shallowOut.length > 0 || plan.unshallowOut.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallowOut) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(FLUSH);
  }
  if (plan.pack) {
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPackets(plan.pack));
    parts.push(FLUSH);
  }
  return Buffer.concat(parts);
}

/**
 * v0 fetch: two request sections (wants/shallow/deepen, flush, haves/done,
 * flush). Response: ACK/NAK lines, then shallow/unshallow lines, then
 * sideband pack packets, then flush.
 */
export function handleFetchV0(store: Store, repo: Repo, body: Buffer): Buffer {
  const section1 = parsePktLines(body);
  const wants: Oid[] = [];
  const shallow: Oid[] = [];
  let depth: number | null = null;
  for (const raw of section1.lines) {
    const line = lineText(raw);
    if (line.startsWith('want ')) {
      // The first want line may carry capabilities after the oid.
      const oid = line.slice(5).split(' ')[0];
      if (isOid(oid)) wants.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (isOid(oid)) shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
    // deepen-since, deepen-not and unknown lines are ignored.
  }
  const haves: Oid[] = [];
  if (section1.rest.length > 0) {
    const section2 = parsePktLines(section1.rest);
    for (const raw of section2.lines) {
      const line = lineText(raw);
      if (line.startsWith('have ')) {
        const oid = line.slice(5).trim();
        if (isOid(oid)) haves.push(oid);
      }
      // 'done' and unknown lines are ignored.
    }
  }
  if (wants.length === 0) throw new Error('fetch with no wants');
  const plan = planFetch(store, repo, { wants, haves, shallow, depth });
  const parts: Buffer[] = [];
  if (plan.ackHaves.length > 0) {
    for (const oid of plan.ackHaves) parts.push(pktLine(`ACK ${oid}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of plan.shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallowOut) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.pack) parts.push(...sidebandPackets(plan.pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// receive-pack (protocol v0)
// ---------------------------------------------------------------------------------------------

interface ReceiveCommand {
  oldOid: Oid;
  newOid: Oid;
  ref: string;
}

const COMMAND_RE = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/;

/**
 * Receive-pack: parse the command list + raw pack, unpack and store the
 * objects, apply each ref update independently (per-ref ok/ng), and return
 * the report-status body. With side-band-64k negotiated (always in the
 * suite) the report is pkt-framed INSIDE band 1; without it the report
 * stream is returned directly. Unpack failures are reported as
 * `unpack <detail>` with HTTP 200 (never thrown) — but a body that is not
 * even pkt-framed throws, and the HTTP layer answers 400.
 */
export function handleReceivePack(store: Store, repo: Repo, body: Buffer): Buffer {
  const parsed = parsePktLines(body);
  const commands: ReceiveCommand[] = [];
  const caps = new Set<string>();
  for (let i = 0; i < parsed.lines.length; i += 1) {
    let line = lineText(parsed.lines[i]);
    if (i === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        for (const token of line.slice(nul + 1).split(' ')) {
          if (token) caps.add(token);
        }
        line = line.slice(0, nul);
      }
    }
    const m = COMMAND_RE.exec(line);
    if (!m) throw new Error(`bad receive-pack command: ${JSON.stringify(line.slice(0, 80))}`);
    commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
  }
  if (commands.length === 0) throw new Error('receive-pack with no commands');

  const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (needsPack) {
    const packBytes = parsed.rest;
    if (packBytes.length === 0) {
      unpackOk = false;
      unpackDetail = 'unpacker error';
    } else {
      try {
        const objects = parsePack(packBytes, (oid) => store.getObject(repo, oid));
        for (const obj of objects) store.putObject(repo, obj.type, obj.data);
      } catch (err) {
        unpackOk = false;
        const detail = (err instanceof Error ? err.message : String(err)).replace(/[\r\n]+/g, ' ').slice(0, 200);
        unpackDetail = detail || 'unpacker error';
      }
    }
  }

  // Per-ref outcomes, in command order. On unpack failure no ref moves and
  // every command is ng (a refused update still reports `unpack ok` when the
  // pack itself was fine — unpack and ref decisions are independent).
  const reportLines: string[] = [unpackOk ? 'unpack ok' : `unpack ${unpackDetail}`];
  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpacker error`);
      continue;
    }
    const result = store.applyRefUpdate(repo, command.ref, command.oldOid, command.newOid);
    if (result.ok) reportLines.push(`ok ${command.ref}`);
    else reportLines.push(`ng ${command.ref} ${result.reason ?? 'failed'}`);
  }

  const wantReport = caps.has('report-status') || caps.has('report-status-v2');
  if (!wantReport) return FLUSH;
  const inner = Buffer.concat([...reportLines.map((line) => pktLine(`${line}\n`)), FLUSH]);
  if (!caps.has('side-band-64k')) return inner;
  // Sideband framing: the pkt-framed report travels inside band-1 packets,
  // and the outer stream ends with a flush packet.
  const out: Buffer[] = [];
  for (let off = 0; off < inner.length; off += SIDEBAND_MAX_DATA) {
    const chunk = inner.subarray(off, off + SIDEBAND_MAX_DATA);
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}
