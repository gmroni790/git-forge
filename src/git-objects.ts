// Git object model: sha1 ids, commit/tree/tag parse+build, tree flattening
// and rebuilding, reachability walks, packfile parse (incl. OFS/REF deltas)
// and generate (plain objects, deterministic). The server is a byte store:
// objects are stored and served verbatim, never re-serialised.

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';
import type { CommitInfo, GitObject, ObjectType, Oid, TagInfo, TreeEntry } from './types.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** sha1('<type> <len>\0' + data), lowercase hex. */
export function hashObject(type: ObjectType, data: Buffer): Oid {
  return createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
}

function splitHeaders(data: Buffer): { headers: string; message: string } {
  const sep = data.indexOf('\n\n');
  if (sep === -1) return { headers: data.toString('utf8'), message: '' };
  return { headers: data.subarray(0, sep).toString('utf8'), message: data.subarray(sep + 2).toString('utf8') };
}

/** Parse header lines; continuation lines (leading space) belong to the previous header. */
function parseHeaders(headers: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let currentKey = '';
  for (const line of headers.split('\n')) {
    if (line.startsWith(' ') && currentKey !== '') continue; // continuation of previous header
    const sp = line.indexOf(' ');
    if (sp === -1) { currentKey = ''; continue; }
    currentKey = line.slice(0, sp);
    const value = line.slice(sp + 1);
    const arr = out.get(currentKey);
    if (arr) arr.push(value);
    else out.set(currentKey, [value]);
  }
  return out;
}

export function parseCommit(data: Buffer): CommitInfo {
  const { headers, message } = splitHeaders(data);
  const h = parseHeaders(headers);
  const tree = h.get('tree')?.[0];
  if (!tree) throw new Error('commit has no tree header');
  return {
    tree,
    parents: h.get('parent') ?? [],
    author: h.get('author')?.[0] ?? '',
    committer: h.get('committer')?.[0] ?? '',
    message,
  };
}

/** 'tree <oid>\n' + parents + 'author ...\ncommitter ...\n\n' + message (verbatim). */
export function buildCommit(info: CommitInfo): Buffer {
  let out = `tree ${info.tree}\n`;
  for (const p of info.parents) out += `parent ${p}\n`;
  out += `author ${info.author}\ncommitter ${info.committer}\n\n`;
  return Buffer.concat([Buffer.from(out, 'utf8'), Buffer.from(info.message, 'utf8')]);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp === -1) throw new Error('malformed tree: no space after mode');
    const mode = data.subarray(i, sp).toString('utf8');
    const nul = data.indexOf(0, sp + 1);
    if (nul === -1) throw new Error('malformed tree: no NUL after name');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    if (nul + 21 > data.length) throw new Error('malformed tree: truncated oid');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid, kind: mode === '40000' ? 'tree' : 'blob' });
    i = nul + 21;
  }
  return entries;
}

/** Git sort key: name bytes, directories compared as name + '/'. */
function treeSortKey(e: TreeEntry): Buffer {
  return Buffer.from(e.kind === 'tree' ? `${e.name}/` : e.name, 'utf8');
}

/** Build a tree buffer from entries, git-sorted; modes as given ('40000' dirs, '100644' files). */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = entries.slice().sort((a, b) => Buffer.compare(treeSortKey(a), treeSortKey(b)));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTag(data: Buffer): TagInfo {
  const { headers, message } = splitHeaders(data);
  const h = parseHeaders(headers);
  const type = h.get('type')?.[0] ?? 'commit';
  return {
    object: h.get('object')?.[0] ?? ZERO_OID,
    type: (type === 'commit' || type === 'tree' || type === 'blob' || type === 'tag' ? type : 'commit'),
    tag: h.get('tag')?.[0] ?? '',
    tagger: h.get('tagger')?.[0] ?? '',
    message,
  };
}

/** Recursive path -> blob map; path uses '/'. Throws on a missing object. */
export function flattenTree(getObject: (oid: Oid) => GitObject | null, treeOid: Oid): Map<string, { oid: Oid; mode: string }> {
  const out = new Map<string, { oid: Oid; mode: string }>();
  const walk = (oid: Oid, prefix: string): void => {
    const obj = getObject(oid);
    if (!obj) throw new Error(`missing tree object ${oid}`);
    if (obj.type !== 'tree') throw new Error(`object ${oid} is not a tree`);
    for (const e of parseTree(obj.data)) {
      if (e.mode === '160000') continue; // gitlink: not followed
      const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.kind === 'tree') walk(e.oid, path);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

interface DirNode {
  files: Map<string, { oid: Oid; mode: string }>;
  dirs: Map<string, DirNode>;
}

/**
 * Apply file changes (Buffer = new content, null = delete) onto base tree
 * (null = empty); returns the new root tree oid + every new object created
 * (trees + blobs) so the caller can store them. Prunes empty dirs. Reuses
 * unchanged subtrees (same oid) — those are NOT in `created`.
 */
export function buildTreeFromFiles(
  getObject: (oid: Oid) => GitObject | null,
  baseTreeOid: Oid | null,
  changes: Map<string, Buffer | null>,
): { treeOid: Oid; created: { type: ObjectType; data: Buffer }[] } {
  const files = baseTreeOid === null ? new Map<string, { oid: Oid; mode: string }>() : flattenTree(getObject, baseTreeOid);
  const created: { type: ObjectType; data: Buffer }[] = [];
  const emitted = new Set<Oid>();
  const emit = (type: ObjectType, data: Buffer): Oid => {
    const oid = hashObject(type, data);
    if (!emitted.has(oid) && getObject(oid) === null) {
      emitted.add(oid);
      created.push({ type, data });
    }
    return oid;
  };

  for (const [path, content] of changes) {
    if (content === null) {
      files.delete(path);
      continue;
    }
    // A file at `path` replaces anything beneath it, and any file at an
    // ancestor of `path` (a path cannot be both file and directory).
    for (const key of [...files.keys()]) {
      if (key.startsWith(`${path}/`)) files.delete(key);
    }
    const segments = path.split('/');
    for (let i = 1; i < segments.length; i += 1) files.delete(segments.slice(0, i).join('/'));
    const oid = emit('blob', content);
    files.set(path, { oid, mode: '100644' });
  }

  // Nest the flat map into a directory tree.
  const root: DirNode = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      let next = node.dirs.get(segments[i]);
      if (!next) { next = { files: new Map(), dirs: new Map() }; node.dirs.set(segments[i], next); }
      node = next;
    }
    node.files.set(segments[segments.length - 1], entry);
  }

  const build = (node: DirNode): Oid => {
    const entries: TreeEntry[] = [];
    for (const [name, f] of node.files) entries.push({ mode: f.mode, name, oid: f.oid, kind: 'blob' });
    for (const [name, sub] of node.dirs) entries.push({ mode: '40000', name, oid: build(sub), kind: 'tree' });
    return emit('tree', buildTree(entries));
  };
  return { treeOid: build(root), created };
}

/** commit -> tree + parents; tree -> entries (skip mode 160000); tag -> target. */
export function collectReachable(getObject: (oid: Oid) => GitObject | null, tips: Oid[]): Set<Oid> {
  const out = new Set<Oid>();
  const stack = tips.slice();
  while (stack.length > 0) {
    const oid = stack.pop() as Oid;
    if (out.has(oid)) continue;
    const obj = getObject(oid);
    if (!obj) continue;
    out.add(oid);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      stack.push(info.tree, ...info.parents);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode !== '160000') stack.push(e.oid);
      }
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return out;
}

/**
 * Absolute depth from tips (tip = generation 1). `shallow` = included commits
 * at the boundary (generation == depth) that HAVE parents (a root commit at
 * the boundary is not shallow — it has no parents to hide). Trees/blobs of
 * included commits are included.
 */
export function collectReachableDepth(
  getObject: (oid: Oid) => GitObject | null,
  tips: Oid[],
  depth: number,
): { included: Set<Oid>; shallow: Set<Oid> } {
  const included = new Set<Oid>();
  const shallow = new Set<Oid>();
  if (depth < 1) return { included, shallow };
  const seenGen = new Set<Oid>();
  const includeTree = (treeOid: Oid): void => {
    const stack = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop() as Oid;
      if (included.has(oid)) continue;
      const obj = getObject(oid);
      if (!obj || obj.type !== 'tree') continue;
      included.add(oid);
      for (const e of parseTree(obj.data)) {
        if (e.mode === '160000') continue;
        if (e.kind === 'tree') stack.push(e.oid);
        else included.add(e.oid);
      }
    }
  };

  let current = tips.slice();
  let gen = 1;
  while (current.length > 0 && gen <= depth) {
    const next: Oid[] = [];
    const work = current.slice();
    while (work.length > 0) {
      const oid = work.pop() as Oid;
      if (seenGen.has(oid)) continue;
      const obj = getObject(oid);
      if (!obj) continue;
      seenGen.add(oid);
      included.add(oid);
      if (obj.type === 'commit') {
        const info = parseCommit(obj.data);
        includeTree(info.tree);
        if (gen === depth) {
          if (info.parents.length > 0) shallow.add(oid);
        } else {
          next.push(...info.parents);
        }
      } else if (obj.type === 'tag') {
        work.push(parseTag(obj.data).object); // tag target: same generation
      } else if (obj.type === 'tree') {
        includeTree(oid);
      }
    }
    current = next;
    gen += 1;
  }
  return { included, shallow };
}

/** Standard git delta ops. Throws on malformed delta. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (pos >= delta.length) throw new Error('delta: truncated varint');
      const b = delta[pos++];
      value |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
      if (shift > 28) throw new Error('delta: varint too large');
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta: source size mismatch');
  const out: Buffer[] = [];
  let outLen = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op === 0) throw new Error('delta: opcode 0 is invalid');
    if ((op & 0x80) !== 0) {
      // Copy from base: offset/size bytes follow per the opcode's bit flags.
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          if (pos >= delta.length) throw new Error('delta: truncated copy op');
          offset |= delta[pos++] << (8 * i);
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          if (pos >= delta.length) throw new Error('delta: truncated copy op');
          size |= delta[pos++] << (8 * i);
        }
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta: copy out of range');
      out.push(base.subarray(offset, offset + size));
      outLen += size;
    } else {
      // Insert the next `op` bytes literally.
      if (pos + op > delta.length) throw new Error('delta: truncated insert op');
      out.push(delta.subarray(pos, pos + op));
      outLen += op;
      pos += op;
    }
  }
  if (outLen !== targetSize) throw new Error('delta: target size mismatch');
  return Buffer.concat(out, targetSize);
}

/**
 * Inflate the zlib stream starting at `start` (which must inflate to exactly
 * `expectedSize` bytes). One inflateSync call: with `{ info: true }` Node
 * reports the engine's bytesWritten, the exact number of input bytes the
 * stream consumed, so no search for the stream end is needed. Throws if the
 * stream does not inflate or yields the wrong size.
 */
function inflateAt(buf: Buffer, start: number, end: number, expectedSize: number): { data: Buffer; consumed: number } {
  const view = buf.subarray(start, end);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch {
    throw new Error('pack: cannot inflate entry');
  }
  const consumed = result.engine.bytesWritten;
  if (!consumed || consumed <= 0) throw new Error('pack: cannot inflate entry');
  if (result.buffer.length !== expectedSize) throw new Error('pack: entry size mismatch');
  return { data: result.buffer, consumed };
}

interface RawEntry {
  offset: number;
  kind: 'plain' | 'ofs' | 'ref';
  type: ObjectType | null; // plain entries only
  data: Buffer;            // inflated payload (plain object, or delta bytes)
  baseOffset: number;      // OFS_DELTA only: absolute offset of the base entry
  baseOid: Oid;            // REF_DELTA only
}

/**
 * Parse a version 2/3 pack: verify 'PACK', version, count, trailer SHA-1
 * (throw on mismatch); inflate entries; resolve OFS_DELTA (base = earlier
 * entry in this pack) and REF_DELTA (base in pack or via resolveBase); apply
 * delta ops. Throws Error on any malformation. Returns objects in pack order.
 */
export function parsePack(buf: Buffer, resolveBase?: (oid: Oid) => GitObject | null): { type: ObjectType; data: Buffer }[] {
  if (buf.length < 32) throw new Error('pack: too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack: bad magic');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack: unsupported version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const actual = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!actual.equals(trailer)) throw new Error('pack: trailer checksum mismatch');
  const end = buf.length - 20;

  const raw: RawEntry[] = [];
  let pos = 12;
  for (let n = 0; n < count; n += 1) {
    if (pos >= end) throw new Error('pack: truncated (fewer entries than count)');
    const offset = pos;
    let b = buf[pos++];
    const typeCode = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while ((b & 0x80) !== 0) {
      if (pos >= end) throw new Error('pack: truncated entry header');
      b = buf[pos++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === 6) {
      // OFS_DELTA: base-offset varint (offset-backwards encoding).
      if (pos >= end) throw new Error('pack: truncated ofs-delta header');
      b = buf[pos++];
      let baseBack = b & 0x7f;
      while ((b & 0x80) !== 0) {
        if (pos >= end) throw new Error('pack: truncated ofs-delta header');
        b = buf[pos++];
        baseBack = ((baseBack + 1) << 7) | (b & 0x7f);
      }
      const { data, consumed } = inflateAt(buf, pos, end, size);
      pos += consumed;
      raw.push({ offset, kind: 'ofs', type: null, data, baseOffset: offset - baseBack, baseOid: '' });
    } else if (typeCode === 7) {
      // REF_DELTA: 20-byte base oid.
      if (pos + 20 > end) throw new Error('pack: truncated ref-delta header');
      const baseOid = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      const { data, consumed } = inflateAt(buf, pos, end, size);
      pos += consumed;
      raw.push({ offset, kind: 'ref', type: null, data, baseOffset: 0, baseOid });
    } else {
      const type = CODE_TYPES[typeCode];
      if (!type) throw new Error(`pack: unknown object type ${typeCode}`);
      const { data, consumed } = inflateAt(buf, pos, end, size);
      pos += consumed;
      raw.push({ offset, kind: 'plain', type, data, baseOffset: 0, baseOid: '' });
    }
  }
  if (pos !== end) throw new Error('pack: stray bytes before trailer');

  // Resolve: plain entries first, then deltas (possibly chained) until fixed.
  const resolved: ({ type: ObjectType; data: Buffer } | null)[] = raw.map(() => null);
  const byOffset = new Map<number, { type: ObjectType; data: Buffer }>();
  const byOid = new Map<Oid, { type: ObjectType; data: Buffer }>();
  const store = (i: number, obj: { type: ObjectType; data: Buffer }): void => {
    resolved[i] = obj;
    byOffset.set(raw[i].offset, obj);
    byOid.set(hashObject(obj.type, obj.data), obj);
  };
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i].kind === 'plain') store(i, { type: raw[i].type as ObjectType, data: raw[i].data });
  }
  let remaining = raw.filter((r) => r.kind !== 'plain').length;
  while (remaining > 0) {
    let progress = false;
    for (let i = 0; i < raw.length; i += 1) {
      if (resolved[i] !== null) continue;
      const entry = raw[i];
      let base: { type: ObjectType; data: Buffer } | null | undefined;
      if (entry.kind === 'ofs') {
        base = byOffset.get(entry.baseOffset);
      } else {
        base = byOid.get(entry.baseOid) ?? (resolveBase ? resolveBase(entry.baseOid) ?? undefined : undefined);
      }
      if (!base) continue;
      store(i, { type: base.type, data: applyDelta(base.data, entry.data) });
      remaining -= 1;
      progress = true;
    }
    if (!progress) throw new Error('pack: unresolved delta base (missing base or cycle)');
  }
  return resolved as { type: ObjectType; data: Buffer }[];
}

/**
 * Version 2 pack, PLAIN objects only (no deltas), entries in the GIVEN order
 * (caller sorts deterministically, e.g. by oid), zlib level 6, correct count
 * + SHA-1 trailer. Empty list => valid 32-byte empty pack.
 */
export function buildPack(objects: { oid: Oid; type: ObjectType; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const typeCode = TYPE_CODES[obj.type];
    const size = obj.data.length;
    // Type/size varint: first byte (type << 4) | (size & 0x0f), then 7-bit LE groups.
    const headerBytes: number[] = [];
    let first = (typeCode << 4) | (size & 0x0f);
    let rest = size >>> 4;
    if (rest !== 0) first |= 0x80;
    headerBytes.push(first);
    while (rest !== 0) {
      let byte = rest & 0x7f;
      rest >>>= 7;
      if (rest !== 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(obj.data, { level: 6 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}
