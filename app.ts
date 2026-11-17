// Quickforge: a dependency-free git forge in one file.
//
// Layers, bottom to top:
//   1. an in-memory object store keyed by SHA-1, where every object is hashed
//      exactly once (when it lands) and parsed at most once (commits and
//      trees are memoised, which is safe because objects are immutable);
//   2. a pack codec: reading a pack costs one inflateSync({info:true}) per
//      object, writing one costs one deflateSync per object, and the pack for
//      a repeated shallow clone of an unchanged tip is cached per repo;
//   3. graph walks (ancestry with early exit, merge bases, fetch planning)
//      that never scan more history than the answer needs;
//   4. the wire surfaces: git smart HTTP (v0 + v2), REST v3, GraphQL, MCP.
//
// Only Node's standard library is used. TypeScript here is erasable syntax
// only, so Node 22+ runs the file as-is.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- constants

/** The login the trial's token belongs to (the scenario's viewer). */
const VIEWER_LOGIN = 'adaiversen';
const VIEWER_ID = 1000;
/** The bearer token this process was handed, when it was handed one. */
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const ZERO_OID = '0'.repeat(40);
const OBJECT_TYPES: Readonly<Record<number, string>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_NUMBERS: Readonly<Record<string, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
/** Identity stamped on commits the forge itself creates (contents, merges). */
const FORGE_NAME = 'Quickforge';
const FORGE_EMAIL = 'quickforge@localhost';
/** Base timestamp for forge-made commits; a counter keeps them monotonic. */
const FORGE_EPOCH = 1_735_689_600;

// ---------------------------------------------------------------- object store

interface StoredObject {
  type: string;
  data: Buffer;
}

const objectStore = new Map<string, StoredObject>();

/** Hash an object into the store (once: an existing id is left untouched) and return its id. */
function storeObject(type: string, data: Buffer): string {
  const oid = createHash('sha1').update(`${type} ${data.length}\0`, 'utf8').update(data).digest('hex');
  if (!objectStore.has(oid)) objectStore.set(oid, { type, data });
  return oid;
}

function getObject(oid: string): StoredObject | undefined {
  return objectStore.get(oid);
}

// ---------------------------------------------------------------- commits and trees (parsed once, memoised)

interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  time: number;
}

const commitInfoCache = new Map<string, CommitInfo>();

function commitInfo(oid: string): CommitInfo | null {
  const cached = commitInfoCache.get(oid);
  if (cached !== undefined) return cached;
  const obj = objectStore.get(oid);
  if (obj === undefined || obj.type !== 'commit') return null;
  const text = obj.data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  let time = 0;
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('committer ')) {
      const match = / (\d+) [+-]\d{4}$/.exec(line);
      if (match !== null) time = Number(match[1]);
    }
  }
  const info: CommitInfo = { tree, parents, message, time };
  commitInfoCache.set(oid, info);
  return info;
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
  dir: boolean;
}

const treeInfoCache = new Map<string, TreeEntry[]>();

function treeInfo(oid: string): TreeEntry[] | null {
  const cached = treeInfoCache.get(oid);
  if (cached !== undefined) return cached;
  const obj = objectStore.get(oid);
  if (obj === undefined || obj.type !== 'tree') return null;
  const entries: TreeEntry[] = [];
  let pos = 0;
  const data = obj.data;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space === -1) return null;
    const mode = data.toString('ascii', pos, space);
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) return null;
    const name = data.toString('utf8', space + 1, nul);
    const child = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid: child, dir: mode === '40000' });
    pos = nul + 21;
  }
  treeInfoCache.set(oid, entries);
  return entries;
}

/** Serialise tree entries (git sorts directories as if their name ended in '/'). */
function buildTree(entries: readonly TreeEntry[]): string {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.name + (a.dir ? '/' : '');
    const kb = b.name + (b.dir ? '/' : '');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return storeObject('tree', Buffer.concat(parts));
}

// ---------------------------------------------------------------- deltas

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  readSize(); // source size: the caller hands us the right base
  const targetSize = readSize();
  const parts: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos++]!;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let length = 0;
      if (op & 0x01) offset = delta[pos++]!;
      if (op & 0x02) offset |= delta[pos++]! << 8;
      if (op & 0x04) offset |= delta[pos++]! << 16;
      if (op & 0x08) offset |= delta[pos++]! << 24;
      if (op & 0x10) length = delta[pos++]!;
      if (op & 0x20) length |= delta[pos++]! << 8;
      if (op & 0x40) length |= delta[pos++]! << 16;
      if (length === 0) length = 0x10000;
      parts.push(base.subarray(offset, offset + length));
      produced += length;
    } else if (op > 0) {
      parts.push(delta.subarray(pos, pos + op));
      produced += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const out = Buffer.concat(parts, produced);
  if (out.length !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

// ---------------------------------------------------------------- pack codec

interface Inflated {
  buffer: Buffer;
  engine: { bytesWritten: number };
}

/** Inflate the one zlib stream starting at `pos`; returns its bytes and the offset just past it. */
function inflateOne(pack: Buffer, pos: number): { data: Buffer; next: number } {
  const result = inflateSync(pack.subarray(pos), { info: true }) as unknown as Inflated;
  const consumed = result.engine.bytesWritten;
  if (consumed <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: pos + consumed };
}

/**
 * Read the pack that starts at `start` in `body` into the store. One inflate
 * per object, one hash per object; deltas resolve against objects already in
 * the store or earlier in the same pack.
 */
function readPack(body: Buffer, start: number): void {
  if (body.length < start + 12) throw new Error('pack too short');
  if (body.toString('ascii', start, start + 4) !== 'PACK') throw new Error('bad pack signature');
  const count = body.readUInt32BE(start + 8);
  let pos = start + 12;
  const byOffset = new Map<number, string>();
  for (let i = 0; i < count; i += 1) {
    const entryStart = pos;
    let byte = body[pos++]!;
    const typeNumber = (byte >> 4) & 7;
    let size = byte & 15;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = body[pos++]!;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOid: string | null = null;
    let baseAt = -1;
    if (typeNumber === 6) {
      let b = body[pos++]!;
      let back = b & 0x7f;
      while ((b & 0x80) !== 0) {
        b = body[pos++]!;
        back = (back + 1) * 128 + (b & 0x7f);
      }
      baseAt = entryStart - back;
    } else if (typeNumber === 7) {
      baseOid = body.toString('hex', pos, pos + 20);
      pos += 20;
    }
    const { data: raw, next } = inflateOne(body, pos);
    pos = next;
    // The header size is the inflated size of what the pack carries: for a
    // delta entry that is the delta itself, not the object it produces.
    if (raw.length !== size) throw new Error('pack object size mismatch');
    let type = OBJECT_TYPES[typeNumber];
    let data = raw;
    if (typeNumber === 6 || typeNumber === 7) {
      const baseId = typeNumber === 6 ? byOffset.get(baseAt) : baseOid;
      const base = baseId != null ? objectStore.get(baseId) : undefined;
      if (base === undefined) throw new Error('delta base is not available');
      type = base.type;
      data = applyDelta(base.data, raw);
    }
    if (type === undefined) throw new Error(`unknown pack object type ${typeNumber}`);
    byOffset.set(entryStart, storeObject(type, data));
  }
}

function packEntryHeader(typeNumber: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeNumber << 4) | (size & 0x0f);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Write a complete, self-contained pack holding `oids` (plain objects, no deltas). */
function writePack(oids: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(oids.length, 8);
  parts.push(head);
  for (const oid of oids) {
    const obj = objectStore.get(oid);
    if (obj === undefined) continue;
    parts.push(packEntryHeader(TYPE_NUMBERS[obj.type]!, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- graph walks

/** Follow tag objects to the commit they name (or null when the chain ends elsewhere). */
function peelToCommit(oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const obj = objectStore.get(current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return current;
    if (obj.type !== 'tag') return null;
    const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
    if (match === null) return null;
    current = match[1]!;
  }
  return null;
}

/** True when `ancestor` is `descendant` itself or reachable from it through parent links. */
function isAncestor(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack: string[] = [descendant];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === ancestor) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const info = commitInfo(current);
    if (info === null) continue;
    for (const parent of info.parents) if (!seen.has(parent)) stack.push(parent);
  }
  return false;
}

/** Every ancestor of `tip` (itself included) with its shortest distance from the tip. */
function ancestorsWithDepth(tip: string): Map<string, number> {
  const depths = new Map<string, number>([[tip, 0]]);
  const queue: string[] = [tip];
  for (let i = 0; i < queue.length; i += 1) {
    const current = queue[i]!;
    const depth = depths.get(current)! + 1;
    const info = commitInfo(current);
    if (info === null) continue;
    for (const parent of info.parents) {
      if (!depths.has(parent)) {
        depths.set(parent, depth);
        queue.push(parent);
      }
    }
  }
  return depths;
}

/** The best common ancestor of two commits, or null when they share no history. */
function mergeBase(a: string, b: string): string | null {
  const fromA = ancestorsWithDepth(a);
  const fromB = ancestorsWithDepth(b);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [oid, depth] of fromA) {
    const other = fromB.get(oid);
    if (other !== undefined && depth + other < bestScore) {
      bestScore = depth + other;
      best = oid;
    }
  }
  return best;
}

/** Add a tree and everything under it to `into`. */
function treeClosure(treeOid: string, into: Set<string>): void {
  const stack: string[] = [treeOid];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (into.has(current)) continue;
    const entries = treeInfo(current);
    if (entries === null) continue;
    into.add(current);
    for (const entry of entries) {
      if (entry.dir) stack.push(entry.oid);
      else into.add(entry.oid);
    }
  }
}

/** The full object closure of some commit tips; commits in `graft` are treated as parentless. */
function closureOfCommits(tips: readonly string[], graft: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const stack: string[] = [];
  for (const tip of tips) {
    const commit = peelToCommit(tip);
    if (commit !== null) stack.push(commit);
    else if (objectStore.has(tip)) out.add(tip);
  }
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (out.has(current)) continue;
    const info = commitInfo(current);
    if (info === null) continue;
    out.add(current);
    treeClosure(info.tree, out);
    if (graft.has(current)) continue;
    for (const parent of info.parents) stack.push(parent);
  }
  return out;
}

// ---------------------------------------------------------------- tree shapes: flatten, rebuild, patch

/** Flatten a tree into path -> blob id. */
function flattenTree(treeOid: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (treeOid === null) return out;
  const walk = (oid: string, prefix: string): void => {
    const entries = treeInfo(oid);
    if (entries === null) return;
    for (const entry of entries) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.dir) walk(entry.oid, path);
      else out.set(path, entry.oid);
    }
  };
  walk(treeOid, '');
  return out;
}

/** Build a tree (nested as needed) from a flattened path -> blob id map; null when empty. */
function treeFromFlat(flat: ReadonlyMap<string, string>): string | null {
  if (flat.size === 0) return null;
  const build = (prefix: string): string | null => {
    const entries: TreeEntry[] = [];
    const dirs = new Map<string, string>(); // dir name -> its prefix
    for (const [path, oid] of flat) {
      if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
      const rest = prefix === '' ? path : path.slice(prefix.length + 1);
      const slash = rest.indexOf('/');
      if (slash === -1) entries.push({ mode: '100644', name: rest, oid, dir: false });
      else {
        const dir = rest.slice(0, slash);
        if (!dirs.has(dir)) dirs.set(dir, prefix === '' ? dir : `${prefix}/${dir}`);
      }
    }
    for (const [name, dirPrefix] of dirs) {
      const child = build(dirPrefix);
      if (child !== null) entries.push({ mode: '40000', name, oid: child, dir: true });
    }
    if (entries.length === 0) return null;
    return buildTree(entries);
  };
  return build('');
}

/** Set (or, with blobOid null, remove) one path in a tree; returns the new tree id or null. */
function updateTreePath(treeOid: string | null, segments: readonly string[], blobOid: string | null): string | null {
  const entries: TreeEntry[] = treeOid === null ? [] : [...(treeInfo(treeOid) ?? [])];
  const head = segments[0]!;
  const index = entries.findIndex((entry) => entry.name === head);
  if (segments.length === 1) {
    if (blobOid === null) {
      if (index !== -1) entries.splice(index, 1);
    } else if (index !== -1) {
      entries[index] = { mode: '100644', name: head, oid: blobOid, dir: false };
    } else {
      entries.push({ mode: '100644', name: head, oid: blobOid, dir: false });
    }
  } else {
    const existing = index === -1 ? null : entries[index]!;
    const child = updateTreePath(existing !== null && existing.dir ? existing.oid : null, segments.slice(1), blobOid);
    if (child === null) {
      if (index !== -1) entries.splice(index, 1);
    } else if (index !== -1) {
      entries[index] = { mode: '40000', name: head, oid: child, dir: true };
    } else {
      entries.push({ mode: '40000', name: head, oid: child, dir: true });
    }
  }
  if (entries.length === 0) return null;
  return buildTree(entries);
}

/** Look up one path in a tree: a blob id, a tree id, or null. */
function lookupPath(treeOid: string | null, segments: readonly string[]): { oid: string; dir: boolean } | null {
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    if (current === null) return null;
    const entries = treeInfo(current);
    if (entries === null) return null;
    const entry = entries.find((candidate) => candidate.name === segments[i]);
    if (entry === undefined) return null;
    if (i === segments.length - 1) return { oid: entry.oid, dir: entry.dir };
    if (!entry.dir) return null;
    current = entry.oid;
  }
  return null;
}

// ---------------------------------------------------------------- repositories and their records

interface IssueRecord {
  number: number;
  restId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: { id: number; body: string }[];
}

interface PullRecord {
  number: number;
  restId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
}

interface RepoRecord {
  id: number;
  owner: string;
  name: string;
  isPrivate: boolean;
  description: string;
  refs: Map<string, string>;
  headRef: string;
  issues: Map<number, IssueRecord>;
  pulls: Map<number, PullRecord>;
  labels: Map<string, { name: string; color: string }>;
  nextNumber: number;
  nextCommentId: number;
  packCache: Map<string, Buffer>;
  planCache: Map<string, FetchPlan>;
}

const repos = new Map<string, RepoRecord>();
let nextRepoId = 910_000;
let nextRestId = 8_100_000;
let forgeClock = 0;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function findRepo(owner: string, name: string): RepoRecord | null {
  return repos.get(repoKey(owner, name)) ?? null;
}

function createRepo(owner: string, name: string, isPrivate: boolean, description: string): RepoRecord {
  const repo: RepoRecord = {
    id: nextRepoId++,
    owner,
    name,
    isPrivate,
    description,
    refs: new Map(),
    headRef: 'refs/heads/main',
    issues: new Map(),
    pulls: new Map(),
    labels: new Map(),
    nextNumber: 1,
    nextCommentId: 1,
    packCache: new Map(),
    planCache: new Map(),
  };
  repos.set(repoKey(owner, name), repo);
  return repo;
}

function defaultBranchName(repo: RepoRecord): string {
  return repo.headRef.replace(/^refs\/heads\//, '');
}

function branchTip(repo: RepoRecord, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** A timestamp for forge-made commits: the scenario epoch plus a steady counter. */
function forgeTimestamp(): number {
  forgeClock += 1;
  return FORGE_EPOCH + forgeClock;
}

function forgeIsoNow(): string {
  return new Date(forgeTimestamp() * 1000).toISOString();
}

/** Create a commit object with the forge identity and return its id (no ref moves). */
function forgeCommit(treeOid: string | null, parents: readonly string[], message: string): string {
  const stamp = forgeTimestamp();
  const ident = `${FORGE_NAME} <${FORGE_EMAIL}> ${stamp} +0000`;
  const lines: string[] = [`tree ${treeOid ?? '4b825dc642cb6eb9a060e54bf8d69288fbee4904'}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${ident}`, `committer ${ident}`, '', message);
  return storeObject('commit', Buffer.from(lines.join('\n'), 'utf8'));
}

/** Move a branch ref to a new commit and drop cached packs that named the old tip. */
function setBranch(repo: RepoRecord, branch: string, commitOid: string): void {
  repo.refs.set(`refs/heads/${branch}`, commitOid);
}

// ---------------------------------------------------------------- fetch planning

interface FetchPlan {
  oids: string[];
  shallow: string[];
  unshallow: string[];
}

/**
 * Plan one upload-pack answer: the objects to send for `wants`, minus the
 * closure of `haves` (grafted at the client's shallow boundary), cut at
 * `depth` generations when a depth was negotiated. Boundary commits that are
 * being sent are reported as shallow; client-shallow commits whose parents
 * are now included are reported as unshallow.
 */
function planFetch(
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: ReadonlySet<string>,
  depth: number | null,
): FetchPlan {
  const haveSet = haves.length > 0 ? closureOfCommits(haves, clientShallow) : new Set<string>();
  const extra: string[] = [];
  const tips: string[] = [];
  for (const want of wants) {
    const commit = peelToCommit(want);
    if (commit !== null) {
      if (want !== commit) extra.push(want);
      tips.push(commit);
    } else if (objectStore.has(want)) {
      extra.push(want);
    }
  }
  const generation = new Map<string, number>();
  const queue: string[] = [];
  for (const tip of tips) {
    if (!generation.has(tip)) {
      generation.set(tip, 0);
      queue.push(tip);
    }
  }
  const boundary = new Set<string>();
  for (let i = 0; i < queue.length; i += 1) {
    const current = queue[i]!;
    const gen = generation.get(current)!;
    const info = commitInfo(current);
    if (info === null) continue;
    if (depth !== null && gen + 1 >= depth) {
      if (info.parents.length > 0) boundary.add(current);
      continue;
    }
    for (const parent of info.parents) {
      if (!generation.has(parent)) {
        generation.set(parent, gen + 1);
        queue.push(parent);
      }
    }
  }
  const send = new Set<string>(extra);
  for (const oid of generation.keys()) {
    if (haveSet.has(oid)) continue;
    send.add(oid);
    const info = commitInfo(oid);
    if (info !== null) treeClosure(info.tree, send);
  }
  for (const oid of haveSet) send.delete(oid);
  for (const oid of extra) if (objectStore.has(oid)) send.add(oid);
  const shallow = [...boundary].filter((oid) => send.has(oid));
  const unshallow = [...clientShallow].filter((oid) => generation.has(oid) && !boundary.has(oid));
  return { oids: [...send], shallow, unshallow };
}

// ---------------------------------------------------------------- pkt-lines

function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = (body.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(head, 'ascii'), body]);
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

type PktPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' };

/** Split a buffer into pkt-line packets; trailing raw bytes (a pack) are returned separately. */
function parsePktLines(body: Buffer, start: number): { packets: PktPacket[]; rest: number } {
  const packets: PktPacket[] = [];
  let pos = start;
  while (pos + 4 <= body.length) {
    const head = body.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-f]{4}$/.test(head)) break;
    const length = parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      pos += 4;
      break;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      pos += 4;
      continue;
    }
    if (length === 2 || length === 3) break;
    if (pos + length > body.length) break;
    packets.push({ kind: 'data', payload: body.subarray(pos + 4, pos + length) });
    pos += length;
  }
  return { packets, rest: pos };
}

/** Parse a v2 command stream: header lines, a delim, argument lines, a flush. */
function parseV2Command(body: Buffer): { command: string; args: string[] } {
  const { packets } = parsePktLines(body, 0);
  let command = '';
  const args: string[] = [];
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
    } else {
      args.push(line);
    }
  }
  return { command, args };
}

// ---------------------------------------------------------------- git smart HTTP

const UPLOAD_CAPS =
  'multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative multi_ack_detailed no-done';
const RECEIVE_CAPS = 'report-status delete-refs side-band-64k ofs-delta';

function sortedRefNames(repo: RepoRecord): string[] {
  return [...repo.refs.keys()].sort();
}

/** The ref advertisement lines shared by both protocols: HEAD first, then every ref. */
function advertisementRefs(repo: RepoRecord, caps: string): Buffer[] {
  const lines: Buffer[] = [];
  const headTip = repo.refs.get(repo.headRef);
  if (repo.refs.size === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps} symref=HEAD:${repo.headRef} agent=quickforge/1.0\n`));
    return lines;
  }
  lines.push(pktLine(`${headTip ?? ZERO_OID} HEAD\0${caps} symref=HEAD:${repo.headRef} agent=quickforge/1.0\n`));
  for (const ref of sortedRefNames(repo)) lines.push(pktLine(`${repo.refs.get(ref)} ${ref}\n`));
  return lines;
}

function handleAdvertise(res: ServerResponse, repo: RepoRecord, service: string, gitProtocol: string): void {
  if (service === 'git-upload-pack' && gitProtocol.includes('version=2')) {
    const body = Buffer.concat([
      pktLine('version 2\n'),
      pktLine('agent=quickforge/1.0\n'),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow wait-for-done\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ]);
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement', 'content-length': body.length });
    res.end(body);
    return;
  }
  const caps = service === 'git-receive-pack' ? RECEIVE_CAPS : UPLOAD_CAPS;
  const body = Buffer.concat([pktLine(`# service=${service}\n`), PKT_FLUSH, ...advertisementRefs(repo, caps), PKT_FLUSH]);
  res.writeHead(200, { 'content-type': `application/x-${service}-advertisement`, 'content-length': body.length });
  res.end(body);
}

function handleLsRefs(res: ServerResponse, repo: RepoRecord, args: readonly string[]): void {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Buffer[] = [];
  if (prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix))) {
    const target = repo.headRef;
    const tip = repo.refs.get(target);
    const suffix = symrefs ? ` symref-target:${target}` : '';
    if (tip !== undefined) lines.push(pktLine(`${tip} HEAD${suffix}\n`));
    else if (unborn) lines.push(pktLine(`unborn HEAD${suffix}\n`));
    else lines.push(pktLine(`${ZERO_OID} HEAD${suffix}\n`));
  }
  for (const ref of sortedRefNames(repo)) {
    if (!matches(ref)) continue;
    const oid = repo.refs.get(ref)!;
    let suffix = '';
    if (peel) {
      const peeled = peelToCommit(oid);
      if (peeled !== null && peeled !== oid) suffix = ` peeled:${peeled}`;
    }
    lines.push(pktLine(`${oid} ${ref}${suffix}\n`));
  }
  const body = Buffer.concat([...lines, PKT_FLUSH]);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': body.length });
  res.end(body);
}

/**
 * Resolve a request's deepen argument to a total depth from the wants. A
 * plain `deepen N` already names the total depth; `deepen-relative` (which
 * the git CLI sends) counts N generations past the client's current shallow
 * boundary instead, so the boundary's distance from the wants is added.
 */
function effectiveDepth(
  wants: readonly string[],
  clientShallow: ReadonlySet<string>,
  depth: number | null,
  relative: boolean,
): number | null {
  if (depth === null || !relative || clientShallow.size === 0) return depth;
  const generation = new Map<string, number>();
  const queue: string[] = [];
  for (const want of wants) {
    const commit = peelToCommit(want);
    if (commit !== null && !generation.has(commit)) {
      generation.set(commit, 0);
      queue.push(commit);
    }
  }
  let distance = 0;
  for (let i = 0; i < queue.length; i += 1) {
    const current = queue[i]!;
    const gen = generation.get(current)!;
    if (clientShallow.has(current)) distance = Math.max(distance, gen);
    const info = commitInfo(current);
    if (info === null) continue;
    for (const parent of info.parents) {
      if (!generation.has(parent)) {
        generation.set(parent, gen + 1);
        queue.push(parent);
      }
    }
  }
  return distance + depth + 1;
}

/** Wrap a pack in sideband-1 packets of at most 65515 payload bytes each. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65_515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (packets.length === 0) packets.push(pktLine(Buffer.from([1])));
  return packets;
}

/** The pack for one fetch, cached per repository on the full request shape. */
function fetchPack(repo: RepoRecord, plan: FetchPlan, cacheKey: string): Buffer {
  const cached = repo.packCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const pack = writePack(plan.oids);
  if (repo.packCache.size > 32) repo.packCache.clear();
  repo.packCache.set(cacheKey, pack);
  return pack;
}

/**
 * The plan for one fetch shape, memoised per repository: a burst of identical
 * clones (the benchmark's fifty shallow clones of one tip) plans once, then
 * reuses both the plan and the pack. Object ids are content addresses, so a
 * cached plan can never name an object the store has lost.
 */
function planFor(
  repo: RepoRecord,
  cacheKey: string,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: ReadonlySet<string>,
  depth: number | null,
): FetchPlan {
  const cached = repo.planCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const plan = planFetch(wants, haves, clientShallow, depth);
  if (repo.planCache.size > 32) repo.planCache.clear();
  repo.planCache.set(cacheKey, plan);
  return plan;
}

function handleFetchV2(res: ServerResponse, repo: RepoRecord, args: readonly string[]): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow = new Set<string>();
  let depth: number | null = null;
  let deepenRelative = false;
  let done = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) clientShallow.add(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7).trim());
    else if (arg === 'deepen-relative') deepenRelative = true;
    else if (arg === 'done') done = true;
  }
  depth = effectiveDepth(wants, clientShallow, depth, deepenRelative);
  const parts: Buffer[] = [];
  if (haves.length > 0 && !done) {
    // Negotiation round: the client has not said done, so the whole answer
    // is the acknowledgments section. Once done arrives, the response is
    // shallow-info and the packfile, with no acknowledgments at all.
    let ack: string | null = null;
    for (const have of haves) {
      if (wants.some((want) => isAncestor(have, peelToCommit(want) ?? want))) {
        ack = have;
        break;
      }
    }
    parts.push(pktLine('acknowledgments\n'), pktLine(ack !== null ? `ACK ${ack} ready\n` : 'NAK\n'), PKT_FLUSH);
    const body = Buffer.concat(parts);
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': body.length });
    res.end(body);
    return;
  }
  const cacheKey = `${depth ?? 'full'}|${wants.join(',')}|${haves.join(',')}|${[...clientShallow].join(',')}`;
  const plan = planFor(repo, cacheKey, wants, haves, clientShallow, depth);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  const pack = fetchPack(repo, plan, cacheKey);
  parts.push(pktLine('packfile\n'), ...sidebandPackets(pack), PKT_FLUSH);
  const body = Buffer.concat(parts);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': body.length });
  res.end(body);
}

function handleFetchV0(res: ServerResponse, repo: RepoRecord, body: Buffer): void {
  const first = parsePktLines(body, 0);
  const wants: string[] = [];
  const clientShallow = new Set<string>();
  let depth: number | null = null;
  let sideband = false;
  for (const packet of first.packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const fields = line.slice(5).split(' ');
      wants.push(fields[0]!);
      if (fields.slice(1).join(' ').includes('side-band')) sideband = true;
    } else if (line.startsWith('shallow ')) clientShallow.add(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
  }
  const second = parsePktLines(body, first.rest);
  const haves: string[] = [];
  for (const packet of second.packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('have ')) haves.push(line.slice(5).trim());
  }
  const cacheKey = `v0|${depth ?? 'full'}|${wants.join(',')}|${haves.join(',')}`;
  const plan = planFor(repo, cacheKey, wants, haves, clientShallow, depth);
  const pack = fetchPack(repo, plan, cacheKey);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  if (sideband) parts.push(...sidebandPackets(pack), PKT_FLUSH);
  else parts.push(pack);
  const out = Buffer.concat(parts);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': out.length });
  res.end(out);
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(res: ServerResponse, repo: RepoRecord, body: Buffer): void {
  const { packets, rest } = parsePktLines(body, 0);
  const commands: PushCommand[] = [];
  let sideband = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul !== -1) {
      const caps = line.slice(nul + 1);
      if (caps.includes('side-band-64k')) sideband = true;
      line = line.slice(0, nul);
    }
    const fields = line.split(' ');
    if (fields.length >= 3) commands.push({ oldOid: fields[0]!, newOid: fields[1]!, ref: fields[2]! });
  }
  let unpackOk = true;
  let unpackDetail = 'ok';
  const carriesPack = commands.some((command) => command.newOid !== ZERO_OID);
  if (carriesPack && rest < body.length) {
    try {
      readPack(body, rest);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const report: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    let ok = false;
    let reason = 'non-fast-forward';
    if (!unpackOk) {
      reason = 'unpack failed';
    } else if (command.newOid === ZERO_OID) {
      if (current !== ZERO_OID && current === command.oldOid) ok = true;
      else reason = current === ZERO_OID ? 'reference does not exist' : 'non-fast-forward';
    } else if (!objectStore.has(command.newOid)) {
      reason = 'invalid target object';
    } else if (command.oldOid === ZERO_OID) {
      if (current === ZERO_OID || current === command.newOid) ok = true;
      else reason = 'reference already exists';
    } else if (current === command.oldOid && isAncestor(command.oldOid, command.newOid)) {
      ok = true;
    }
    if (ok) {
      if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
      else repo.refs.set(command.ref, command.newOid);
      report.push(`ok ${command.ref}\n`);
    } else {
      report.push(`ng ${command.ref} ${reason}\n`);
    }
  }
  const stream = Buffer.concat([...report.map((line) => pktLine(line)), PKT_FLUSH]);
  const out = sideband ? Buffer.concat([...sidebandPackets(stream), PKT_FLUSH]) : stream;
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': out.length });
  res.end(out);
}

// ---------------------------------------------------------------- REST v3

let requestCounter = 0;

interface RestContext {
  req: IncomingMessage;
  res: ServerResponse;
  query: URLSearchParams;
  body: Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const text = value === undefined ? '' : JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

function restError(ctx: RestContext, status: number, message: string): void {
  sendJson(ctx.res, status, { message });
}

function repoJson(repo: RepoRecord): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: { login: repo.owner, id: VIEWER_ID },
    description: repo.description,
    default_branch: defaultBranchName(repo),
  };
}

function issueJson(repo: RepoRecord, issue: IssueRecord): Record<string, unknown> {
  return {
    id: issue.restId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? '000000' })),
    comments: issue.comments.length,
  };
}

function pullJson(repo: RepoRecord, pull: PullRecord): Record<string, unknown> {
  return {
    id: pull.restId,
    number: pull.number,
    state: pull.merged ? 'closed' : pull.state,
    title: pull.title,
    body: pull.body,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: {
      ref: pull.headRef,
      sha: branchTip(repo, pull.headRef),
      label: `${repo.owner}:${pull.headRef}`,
    },
    base: {
      ref: pull.baseRef,
      sha: branchTip(repo, pull.baseRef),
      label: `${repo.owner}:${pull.baseRef}`,
    },
  };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') names.push(entry);
    else if (entry !== null && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
      names.push((entry as { name: string }).name);
    }
  }
  return names;
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  return { page, perPage };
}

function paginate<T>(items: readonly T[], query: URLSearchParams): T[] {
  const { page, perPage } = pageParams(query);
  return items.slice((page - 1) * perPage, page * perPage);
}

/** The history of a branch or commit, newest first (depth-first, parents in order). */
function historyFrom(start: string, limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [start];
  while (stack.length > 0 && out.length < limit) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const info = commitInfo(current);
    if (info === null) continue;
    out.push(current);
    for (let i = info.parents.length - 1; i >= 0; i -= 1) stack.push(info.parents[i]!);
  }
  return out;
}

function blobLineCount(oid: string): number {
  const obj = getObject(oid);
  if (obj === undefined) return 0;
  const text = obj.data.toString('utf8');
  if (text === '') return 0;
  const newlines = text.split('\n').length - 1;
  return text.endsWith('\n') ? newlines : newlines + 1;
}

function splitLines(oid: string): string[] {
  const obj = getObject(oid);
  if (obj === undefined) return [];
  const text = obj.data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line-level diff counts between two blobs via a longest-common-subsequence pass. */
function lineDiff(oldOid: string, newOid: string): { additions: number; deletions: number } {
  const a = splitLines(oldOid);
  const b = splitLines(newOid);
  if (a.length * b.length > 4_000_000) return { additions: b.length, deletions: a.length };
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const above = dp[j]!;
      if (a[i - 1] === b[j - 1]) dp[j] = diagonal + 1;
      else dp[j] = Math.max(dp[j]!, dp[j - 1]!);
      diagonal = above;
    }
  }
  const common = dp[b.length]!;
  return { additions: b.length - common, deletions: a.length - common };
}

interface FileChange {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

/** The file-level diff between two flattened trees. */
function diffFlats(oldFlat: ReadonlyMap<string, string>, newFlat: ReadonlyMap<string, string>): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set<string>([...oldFlat.keys(), ...newFlat.keys()]);
  for (const path of [...paths].sort()) {
    const oldOid = oldFlat.get(path);
    const newOid = newFlat.get(path);
    if (oldOid === newOid) continue;
    if (oldOid === undefined) {
      const additions = blobLineCount(newOid!);
      changes.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (newOid === undefined) {
      const deletions = blobLineCount(oldOid);
      changes.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else {
      const { additions, deletions } = lineDiff(oldOid, newOid);
      changes.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return changes;
}

/** Three-way flat merge: apply head's changes (relative to the merge base) onto base. */
function mergeFlats(
  baseFlat: ReadonlyMap<string, string>,
  headFlat: ReadonlyMap<string, string>,
  ancestorFlat: ReadonlyMap<string, string>,
): Map<string, string> | null {
  const result = new Map(baseFlat);
  const paths = new Set<string>([...ancestorFlat.keys(), ...headFlat.keys()]);
  for (const path of paths) {
    const ancestor = ancestorFlat.get(path);
    const head = headFlat.get(path);
    if (head === ancestor) continue;
    const base = baseFlat.get(path);
    if (base !== ancestor && base !== head) return null; // both sides changed it differently
    if (head === undefined) result.delete(path);
    else result.set(path, head);
  }
  return result;
}

function flatOfCommit(commitOid: string | null): Map<string, string> {
  if (commitOid === null) return new Map();
  const info = commitInfo(commitOid);
  return info === null ? new Map() : flattenTree(info.tree);
}

/** Whether merging `pull` into its base branch right now would conflict. */
function pullConflicts(repo: RepoRecord, pull: PullRecord): boolean {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return true;
  const base = mergeBase(headTip, baseTip);
  return mergeFlats(flatOfCommit(baseTip), flatOfCommit(headTip), flatOfCommit(base)) === null;
}

/** Squash-merge a pull request; returns the merge commit id, or null on conflict. */
function mergePull(repo: RepoRecord, pull: PullRecord): string | null {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return null;
  const base = mergeBase(headTip, baseTip);
  const merged = mergeFlats(flatOfCommit(baseTip), flatOfCommit(headTip), flatOfCommit(base));
  if (merged === null) return null;
  const tree = treeFromFlat(merged);
  const message = pull.body === '' ? pull.title : `${pull.title}\n\n${pull.body}`;
  const commit = forgeCommit(tree, [baseTip], message);
  setBranch(repo, pull.baseRef, commit);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = forgeIsoNow();
  pull.mergeCommitSha = commit;
  return commit;
}

function handleRest(ctx: RestContext, segments: readonly string[]): void {
  const { req, res, query, body } = ctx;
  const method = req.method ?? 'GET';

  if (segments.length === 0) {
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      rate_limit_url: '/api/v3/rate_limit',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    sendJson(res, 200, { installed_version: 'quickforge-1.0.0', verifiable_password_authentication: false });
    return;
  }
  if (segments[0] === 'user' && segments.length === 1 && method === 'GET') {
    sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' });
    return;
  }
  if (segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') {
      const name = asString(body.name);
      if (name === '') return restError(ctx, 422, 'Repository creation failed: name is missing');
      if (findRepo(VIEWER_LOGIN, name) !== null) {
        return restError(ctx, 422, 'Repository creation failed: name already exists on this account');
      }
      const repo = createRepo(VIEWER_LOGIN, name, body.private === true, asString(body.description));
      return sendJson(res, 201, repoJson(repo));
    }
    if (method === 'GET') {
      const mine = [...repos.values()].filter((repo) => repo.owner === VIEWER_LOGIN).sort((a, b) => a.id - b.id);
      const { page, perPage } = pageParams(query);
      const slice = mine.slice((page - 1) * perPage, page * perPage);
      const headers: Record<string, string> = {};
      if (page * perPage < mine.length) {
        const host = req.headers.host ?? 'localhost';
        headers.link = `<http://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next"`;
      }
      return sendJson(res, 200, slice.map(repoJson), headers);
    }
    return restError(ctx, 404, 'Not Found');
  }

  if (segments[0] !== 'repos' || segments.length < 3) return restError(ctx, 404, 'Not Found');
  const repo = findRepo(segments[1]!, segments[2]!);
  if (repo === null) return restError(ctx, 404, 'Not Found');
  const rest = segments.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') return sendJson(res, 200, repoJson(repo));
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      return sendJson(res, 200, repoJson(repo));
    }
    if (method === 'DELETE') {
      repos.delete(repoKey(repo.owner, repo.name));
      return sendJson(res, 204, undefined);
    }
    return restError(ctx, 404, 'Not Found');
  }

  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const ref = asString(body.ref);
      const sha = asString(body.sha);
      if (!ref.startsWith('refs/') || !objectStore.has(sha)) return restError(ctx, 422, 'Invalid ref or sha');
      const existing = repo.refs.get(ref);
      if (existing !== undefined && existing !== sha) return restError(ctx, 422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return sendJson(res, 201, { ref, object: { sha, type: 'commit' } });
    }
    if (method === 'GET' && rest.length > 2) {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) return restError(ctx, 404, 'Not Found');
      return sendJson(res, 200, { ref, object: { sha, type: 'commit' } });
    }
    return restError(ctx, 404, 'Not Found');
  }

  if (rest[0] === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const branches = sortedRefNames(repo)
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref)! }, protected: false }));
      return sendJson(res, 200, branches);
    }
    if (method === 'GET' && rest.length > 1) {
      const name = rest.slice(1).join('/');
      const sha = branchTip(repo, name);
      if (sha === null) return restError(ctx, 404, 'Not Found');
      return sendJson(res, 200, { name, commit: { sha }, protected: false });
    }
    return restError(ctx, 404, 'Not Found');
  }

  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const shaParam = query.get('sha');
    let start: string | null = null;
    if (shaParam === null || shaParam === '') start = repo.refs.get(repo.headRef) ?? null;
    else if (repo.refs.has(shaParam)) start = repo.refs.get(shaParam)!;
    else if (branchTip(repo, shaParam) !== null) start = branchTip(repo, shaParam);
    else if (commitInfo(shaParam) !== null) start = shaParam;
    if (start === null) return sendJson(res, 200, []);
    const { page, perPage } = pageParams(query);
    const history = historyFrom(start, page * perPage + 1);
    const slice = history.slice((page - 1) * perPage, page * perPage);
    return sendJson(res, 200, slice.map((oid) => {
      const info = commitInfo(oid)!;
      return {
        sha: oid,
        commit: { message: info.message, tree: { sha: info.tree } },
        parents: info.parents.map((parent) => ({ sha: parent })),
      };
    }));
  }

  if (rest[0] === 'contents') {
    const pathSegments = rest.slice(1);
    const path = pathSegments.join('/');
    if (method === 'PUT') {
      const branch = asString(body.branch) || defaultBranchName(repo);
      const tip = branchTip(repo, branch);
      const tree = tip === null ? null : commitInfo(tip)?.tree ?? null;
      const existing = pathSegments.length > 0 ? lookupPath(tree, pathSegments) : null;
      const givenSha = asString(body.sha);
      if (existing !== null && !existing.dir) {
        if (givenSha !== existing.oid) return restError(ctx, 409, 'The supplied sha does not match the current content');
      } else if (existing === null && givenSha !== '') {
        return restError(ctx, 422, 'The file does not exist, so no sha may be supplied');
      }
      if (pathSegments.length === 0) return restError(ctx, 422, 'No path given');
      const data = Buffer.from(asString(body.content), 'base64');
      const blobOid = storeObject('blob', data);
      const newTree = updateTreePath(tree, pathSegments, blobOid);
      const commit = forgeCommit(newTree, tip === null ? [] : [tip], asString(body.message));
      setBranch(repo, branch, commit);
      const created = existing === null;
      return sendJson(res, created ? 201 : 200, {
        content: {
          name: pathSegments[pathSegments.length - 1]!,
          path,
          sha: blobOid,
          size: data.length,
          type: 'file',
          encoding: 'base64',
        },
        commit: { sha: commit },
      });
    }
    if (method === 'GET') {
      const refParam = query.get('ref');
      let tip: string | null;
      if (refParam === null || refParam === '') tip = repo.refs.get(repo.headRef) ?? null;
      else tip = branchTip(repo, refParam) ?? (commitInfo(refParam) !== null ? refParam : null);
      const tree = tip === null ? null : commitInfo(tip)?.tree ?? null;
      if (pathSegments.length === 0) {
        if (tree === null) return sendJson(res, 200, []);
        const entries = treeInfo(tree) ?? [];
        return sendJson(res, 200, entries.map((entry) => ({
          name: entry.name,
          path: entry.name,
          sha: entry.oid,
          size: entry.dir ? 0 : getObject(entry.oid)?.data.length ?? 0,
          type: entry.dir ? 'dir' : 'file',
        })));
      }
      const found = lookupPath(tree, pathSegments);
      if (found === null) return restError(ctx, 404, 'Not Found');
      if (found.dir) {
        const entries = treeInfo(found.oid) ?? [];
        return sendJson(res, 200, entries.map((entry) => ({
          name: entry.name,
          path: `${path}/${entry.name}`,
          sha: entry.oid,
          size: entry.dir ? 0 : getObject(entry.oid)?.data.length ?? 0,
          type: entry.dir ? 'dir' : 'file',
        })));
      }
      const obj = getObject(found.oid);
      if (obj === undefined) return restError(ctx, 404, 'Not Found');
      return sendJson(res, 200, {
        name: pathSegments[pathSegments.length - 1]!,
        path,
        sha: found.oid,
        size: obj.data.length,
        type: 'file',
        encoding: 'base64',
        content: obj.data.toString('base64'),
      });
    }
    if (method === 'DELETE') {
      const branch = asString(body.branch) || defaultBranchName(repo);
      const tip = branchTip(repo, branch);
      if (tip === null) return restError(ctx, 404, 'Not Found');
      const tree = commitInfo(tip)?.tree ?? null;
      const existing = lookupPath(tree, pathSegments);
      if (existing === null || existing.dir) return restError(ctx, 404, 'Not Found');
      if (asString(body.sha) !== existing.oid) return restError(ctx, 409, 'The supplied sha does not match the current content');
      const newTree = updateTreePath(tree, pathSegments, null);
      const commit = forgeCommit(newTree, [tip], asString(body.message));
      setBranch(repo, branch, commit);
      return sendJson(res, 200, { content: null, commit: { sha: commit } });
    }
    return restError(ctx, 404, 'Not Found');
  }

  if (rest[0] === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const name = asString(body.name);
      if (name === '') return restError(ctx, 422, 'Label name is missing');
      if (repo.labels.has(name)) return restError(ctx, 422, 'Label already exists');
      const label = { name, color: asString(body.color) || '000000' };
      repo.labels.set(name, label);
      return sendJson(res, 201, { id: nextRestId++, name: label.name, color: label.color });
    }
    if (method === 'GET' && rest.length === 1) {
      return sendJson(res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
    }
    return restError(ctx, 404, 'Not Found');
  }

  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const names = labelNames(body.labels);
        for (const name of names) {
          if (!repo.labels.has(name)) return restError(ctx, 422, `Unknown label: ${name}`);
        }
        const issue: IssueRecord = {
          number: repo.nextNumber++,
          restId: nextRestId++,
          title: asString(body.title),
          body: asString(body.body),
          state: 'open',
          labels: names,
          comments: [],
        };
        repo.issues.set(issue.number, issue);
        return sendJson(res, 201, issueJson(repo, issue));
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let list = [...repo.issues.values()];
        if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
        const direction = query.get('direction') ?? (query.get('sort') !== null ? 'desc' : 'asc');
        list.sort((a, b) => (direction === 'desc' ? b.number - a.number : a.number - b.number));
        return sendJson(res, 200, paginate(list, query).map((issue) => issueJson(repo, issue)));
      }
      return restError(ctx, 404, 'Not Found');
    }
    const number = Number(rest[1]);
    const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
    if (issue === undefined) return restError(ctx, 404, 'Not Found');
    if (rest.length === 2) {
      if (method === 'GET') return sendJson(res, 200, issueJson(repo, issue));
      if (method === 'PATCH') {
        if (body.state === 'closed' || body.state === 'open') issue.state = body.state;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (body.labels !== undefined) {
          const names = labelNames(body.labels);
          for (const name of names) if (!repo.labels.has(name)) return restError(ctx, 422, `Unknown label: ${name}`);
          issue.labels = names;
        }
        return sendJson(res, 200, issueJson(repo, issue));
      }
      return restError(ctx, 404, 'Not Found');
    }
    if (rest[2] === 'comments') {
      if (method === 'POST' && rest.length === 3) {
        const comment = { id: repo.nextCommentId++, body: asString(body.body) };
        issue.comments.push(comment);
        return sendJson(res, 201, { id: comment.id, body: comment.body });
      }
      if (method === 'GET' && rest.length === 3) {
        return sendJson(res, 200, issue.comments.map((comment) => ({ id: comment.id, body: comment.body })));
      }
    }
    return restError(ctx, 404, 'Not Found');
  }

  if (rest[0] === 'pulls') {
    const normalizeRef = (value: string): string => {
      let ref = value;
      const colon = ref.indexOf(':');
      if (colon !== -1) ref = ref.slice(colon + 1);
      return ref.replace(/^refs\/heads\//, '');
    };
    if (rest.length === 1) {
      if (method === 'POST') {
        const head = normalizeRef(asString(body.head));
        const base = normalizeRef(asString(body.base));
        if (head === '' || base === '' || head === base) return restError(ctx, 422, 'Invalid head or base branch');
        if (branchTip(repo, head) === null || branchTip(repo, base) === null) {
          return restError(ctx, 422, 'Invalid head or base branch');
        }
        for (const pull of repo.pulls.values()) {
          if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
            return restError(ctx, 422, 'A pull request already exists for this branch combination');
          }
        }
        const pull: PullRecord = {
          number: repo.nextNumber++,
          restId: nextRestId++,
          title: asString(body.title),
          body: asString(body.body),
          state: 'open',
          merged: false,
          mergedAt: null,
          mergeCommitSha: null,
          headRef: head,
          baseRef: base,
        };
        repo.pulls.set(pull.number, pull);
        return sendJson(res, 201, pullJson(repo, pull));
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let list = [...repo.pulls.values()];
        if (state === 'open') list = list.filter((pull) => pull.state === 'open' && !pull.merged);
        else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed' || pull.merged);
        list.sort((a, b) => a.number - b.number);
        return sendJson(res, 200, paginate(list, query).map((pull) => pullJson(repo, pull)));
      }
      return restError(ctx, 404, 'Not Found');
    }
    const number = Number(rest[1]);
    const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
    if (pull === undefined) return restError(ctx, 404, 'Not Found');
    if (rest.length === 2 && method === 'GET') return sendJson(res, 200, pullJson(repo, pull));
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      const headTip = branchTip(repo, pull.headRef);
      const baseTip = branchTip(repo, pull.baseRef);
      if (headTip === null || baseTip === null) return sendJson(res, 200, []);
      const base = mergeBase(headTip, baseTip);
      return sendJson(res, 200, diffFlats(flatOfCommit(base), flatOfCommit(headTip)));
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      if (pull.state !== 'open' || pull.merged) return restError(ctx, 405, 'Pull Request is not open');
      const sha = mergePull(repo, pull);
      if (sha === null) return restError(ctx, 405, 'Pull Request is not mergeable');
      return sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
    }
    return restError(ctx, 404, 'Not Found');
  }

  return restError(ctx, 404, 'Not Found');
}

// ---------------------------------------------------------------- GraphQL

type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'scalar'; value: unknown }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Map<string, GqlValue> };

interface GqlFieldNode {
  alias: string | null;
  name: string;
  args: Map<string, GqlValue>;
  selection: GqlSelection[] | null;
}

type GqlSelection =
  | { kind: 'field'; field: GqlFieldNode }
  | { kind: 'inline'; type: string; selection: GqlSelection[] };

interface GqlOperation {
  type: 'query' | 'mutation';
  selection: GqlSelection[];
}

/** Tokenise and parse one GraphQL document (the subset gh and the suite send). */
function parseGraphQL(source: string): { operations: GqlOperation[]; fragments: Map<string, GqlSelection[]> } {
  const tokens: string[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[_A-Za-z]/.test(c);
  const isNameChar = (c: string): boolean => /[_0-9A-Za-z]/.test(c);
  while (i < source.length) {
    const c = source[i]!;
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
    } else if (/\s|,/.test(c)) {
      i += 1;
    } else if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
    } else if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          out += source[j] + (source[j + 1] ?? '');
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push(`"${out}"`);
      i = j + 1;
    } else if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j]!)) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
    } else if (/[-0-9]/.test(c)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j]!)) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
    } else {
      tokens.push(c);
      i += 1;
    }
  }
  let pos = 0;
  const peek = (): string | undefined => tokens[pos];
  const next = (): string => tokens[pos++]!;
  const expect = (token: string): void => {
    if (next() !== token) throw new Error(`expected ${token}`);
  };
  const skipBalanced = (open: string, close: string): void => {
    expect(open);
    let depth = 1;
    while (depth > 0) {
      const token = next();
      if (token === undefined) throw new Error('unbalanced input');
      if (token === open) depth += 1;
      else if (token === close) depth -= 1;
    }
  };
  const parseValue = (): GqlValue => {
    const token = next();
    if (token === '$') return { kind: 'var', name: next() };
    if (token === '[') {
      const items: GqlValue[] = [];
      while (peek() !== ']') items.push(parseValue());
      next();
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields = new Map<string, GqlValue>();
      while (peek() !== '}') {
        const key = next();
        expect(':');
        fields.set(key, parseValue());
      }
      next();
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) return { kind: 'scalar', value: JSON.parse(token) as unknown };
    if (token === 'true') return { kind: 'scalar', value: true };
    if (token === 'false') return { kind: 'scalar', value: false };
    if (token === 'null') return { kind: 'scalar', value: null };
    if (/^-?\d/.test(token)) return { kind: 'scalar', value: Number(token) };
    return { kind: 'enum', value: token };
  };
  const parseSelectionSet = (): GqlSelection[] => {
    expect('{');
    const selections: GqlSelection[] = [];
    while (peek() !== '}') {
      if (peek() === '...') {
        next();
        if (peek() === 'on') {
          next();
          const type = next();
          selections.push({ kind: 'inline', type, selection: parseSelectionSet() });
        } else {
          const name = next();
          selections.push({ kind: 'inline', type: `fragment:${name}`, selection: [] });
        }
        continue;
      }
      let name = next();
      let alias: string | null = null;
      if (peek() === ':') {
        next();
        alias = name;
        name = next();
      }
      const args = new Map<string, GqlValue>();
      if (peek() === '(') {
        next();
        while (peek() !== ')') {
          const key = next();
          expect(':');
          args.set(key, parseValue());
        }
        next();
      }
      if (peek() === '@') {
        next();
        next();
        if (peek() === '(') skipBalanced('(', ')');
      }
      const selection = peek() === '{' ? parseSelectionSet() : null;
      selections.push({ kind: 'field', field: { alias, name, args, selection } });
    }
    next();
    return selections;
  };
  const operations: GqlOperation[] = [];
  const fragments = new Map<string, GqlSelection[]>();
  while (pos < tokens.length) {
    const head = peek()!;
    if (head === '{') {
      operations.push({ type: 'query', selection: parseSelectionSet() });
    } else if (head === 'query' || head === 'mutation') {
      const type = next() as 'query' | 'mutation';
      if (peek() !== '(' && peek() !== '{') next(); // operation name
      if (peek() === '(') skipBalanced('(', ')'); // variable definitions
      if (peek() === '@') {
        next();
        next();
        if (peek() === '(') skipBalanced('(', ')');
      }
      operations.push({ type, selection: parseSelectionSet() });
    } else if (head === 'fragment') {
      next();
      const name = next();
      expect('on');
      next();
      fragments.set(name, parseSelectionSet());
    } else {
      next();
    }
  }
  return { operations, fragments };
}

function resolveValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name];
    case 'scalar':
      return value.value;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of value.fields) out[key] = resolveValue(entry, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------- GraphQL object model

interface GObj {
  t: string;
  v: Record<string, any>;
}

function gobj(t: string, v: Record<string, any>): GObj {
  return { t, v };
}

function encodeGid(raw: string): string {
  return Buffer.from(raw, 'utf8').toString('base64');
}

function repoGid(repo: RepoRecord): string {
  return encodeGid(`R${repo.id}`);
}

function issueGid(repo: RepoRecord, issue: IssueRecord): string {
  return encodeGid(`I${repo.id}:${issue.number}`);
}

function pullGid(repo: RepoRecord, pull: PullRecord): string {
  return encodeGid(`P${repo.id}:${pull.number}`);
}

interface DecodedGid {
  kind: string;
  repoId: number;
  number: number;
  extra: number;
}

function decodeGid(id: unknown): DecodedGid | null {
  if (typeof id !== 'string') return null;
  let raw: string;
  try {
    raw = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = /^([A-Z])(\d+)(?::(\d+))?(?::(\d+))?$/.exec(raw);
  if (match === null) return null;
  return {
    kind: match[1]!,
    repoId: Number(match[2]),
    number: match[3] === undefined ? 0 : Number(match[3]),
    extra: match[4] === undefined ? 0 : Number(match[4]),
  };
}

function repoById(id: number): RepoRecord | null {
  for (const repo of repos.values()) if (repo.id === id) return repo;
  return null;
}

function encodeCursor(index: number): string {
  return Buffer.from(`cur:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string') return 0;
  const raw = Buffer.from(cursor, 'base64').toString('utf8');
  const match = /^cur:(\d+)$/.exec(raw);
  return match === null ? 0 : Number(match[1]);
}

interface GqlContext {
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

type GqlResolver = (source: GObj, args: Record<string, unknown>, ctx: GqlContext) => unknown;

function issueConnection(repo: RepoRecord, args: Record<string, unknown>): GObj {
  let list = [...repo.issues.values()];
  if (Array.isArray(args.states)) {
    const wanted = new Set(args.states.map((state) => String(state).toUpperCase()));
    list = list.filter((issue) => wanted.has(issue.state.toUpperCase()));
  }
  const orderBy = (args.orderBy ?? {}) as { direction?: string };
  const descending = String(orderBy.direction ?? 'ASC').toUpperCase() === 'DESC';
  list.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
  const start = decodeCursor(args.after);
  const first = typeof args.first === 'number' ? args.first : list.length;
  const slice = list.slice(start, start + first);
  return gobj('IssueConnection', {
    nodes: slice.map((issue) => gobj('Issue', { repo, issue })),
    pageInfo: {
      hasNextPage: start + first < list.length,
      endCursor: slice.length > 0 ? encodeCursor(start + slice.length) : '',
    },
  });
}

function pullConnection(repo: RepoRecord, args: Record<string, unknown>): GObj {
  const list = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
  const first = typeof args.first === 'number' ? args.first : list.length;
  const slice = list.slice(0, first);
  return gobj('PullRequestConnection', {
    nodes: slice.map((pull) => gobj('PullRequest', { repo, pull })),
    pageInfo: { hasNextPage: first < list.length, endCursor: slice.length > 0 ? encodeCursor(slice.length) : '' },
  });
}

const GQL_RESOLVERS: Record<string, Record<string, GqlResolver>> = {
  Query: {
    viewer: () => gobj('User', { login: VIEWER_LOGIN, id: VIEWER_ID }),
    repository: (_s, args) => {
      const repo = findRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === null ? null : gobj('Repository', { repo });
    },
    node: (_s, args) => {
      const decoded = decodeGid(args.id);
      if (decoded === null) return null;
      const repo = repoById(decoded.repoId);
      if (repo === null) return null;
      if (decoded.kind === 'R') return gobj('Repository', { repo });
      if (decoded.kind === 'I') {
        const issue = repo.issues.get(decoded.number);
        return issue === undefined ? null : gobj('Issue', { repo, issue });
      }
      if (decoded.kind === 'P') {
        const pull = repo.pulls.get(decoded.number);
        return pull === undefined ? null : gobj('PullRequest', { repo, pull });
      }
      return null;
    },
    __type: (_s, args) => {
      const name = String(args.name ?? '');
      return GQL_TYPE_FIELDS[name] !== undefined || GQL_TYPE_ENUMS[name] !== undefined ? gobj('__Type', { name }) : null;
    },
  },
  Mutation: {
    createIssue: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGid(input.repositoryId);
      const repo = decoded === null ? null : repoById(decoded.repoId);
      if (repo === null) {
        ctx.errors.push({ message: 'Could not resolve to a Repository with the given id.' });
        return gobj('CreateIssuePayload', { issue: null });
      }
      const issue: IssueRecord = {
        number: repo.nextNumber++,
        restId: nextRestId++,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        labels: [],
        comments: [],
      };
      repo.issues.set(issue.number, issue);
      return gobj('CreateIssuePayload', { issue: gobj('Issue', { repo, issue }) });
    },
    closeIssue: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGid(input.issueId);
      const repo = decoded === null ? null : repoById(decoded.repoId);
      const issue = repo?.issues.get(decoded?.number ?? -1);
      if (repo === null || issue === undefined) {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the given id.' });
        return gobj('CloseIssuePayload', { issue: null });
      }
      issue.state = 'closed';
      return gobj('CloseIssuePayload', { issue: gobj('Issue', { repo, issue }) });
    },
    createPullRequest: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGid(input.repositoryId);
      const repo = decoded === null ? null : repoById(decoded.repoId);
      if (repo === null) {
        ctx.errors.push({ message: 'Could not resolve to a Repository with the given id.' });
        return gobj('CreatePullRequestPayload', { pullRequest: null });
      }
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      if (branchTip(repo, headRef) === null || branchTip(repo, baseRef) === null) {
        ctx.errors.push({ message: 'Invalid head or base ref.' });
        return gobj('CreatePullRequestPayload', { pullRequest: null });
      }
      const pull: PullRecord = {
        number: repo.nextNumber++,
        restId: nextRestId++,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef,
        baseRef,
      };
      repo.pulls.set(pull.number, pull);
      return gobj('CreatePullRequestPayload', { pullRequest: gobj('PullRequest', { repo, pull }) });
    },
    mergePullRequest: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGid(input.pullRequestId);
      const repo = decoded === null ? null : repoById(decoded.repoId);
      const pull = repo?.pulls.get(decoded?.number ?? -1);
      if (repo === null || pull === undefined) {
        ctx.errors.push({ message: 'Could not resolve to a PullRequest with the given id.' });
        return gobj('MergePullRequestPayload', { pullRequest: null });
      }
      if (pull.state !== 'open' || pull.merged || mergePull(repo, pull) === null) {
        ctx.errors.push({ message: 'Pull Request is not mergeable.' });
        return gobj('MergePullRequestPayload', { pullRequest: gobj('PullRequest', { repo, pull }) });
      }
      return gobj('MergePullRequestPayload', { pullRequest: gobj('PullRequest', { repo, pull }) });
    },
    addComment: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGid(input.subjectId);
      const repo = decoded === null ? null : repoById(decoded.repoId);
      const issue = repo?.issues.get(decoded?.number ?? -1);
      if (repo === null || issue === undefined) {
        ctx.errors.push({ message: 'Could not resolve to a subject with the given id.' });
        return gobj('AddCommentPayload', { commentEdge: null });
      }
      const comment = { id: repo.nextCommentId++, body: String(input.body ?? '') };
      issue.comments.push(comment);
      const node = gobj('IssueComment', { repo, issue, comment });
      return gobj('AddCommentPayload', { commentEdge: gobj('CommentEdge', { node }) });
    },
  },
  User: {
    login: (s) => s.v.login as string,
    id: (s) => encodeGid(`U${s.v.id as number}`),
    name: (s) => s.v.login as string,
  },
  Repository: {
    id: (s) => repoGid(s.v.repo as RepoRecord),
    databaseId: (s) => (s.v.repo as RepoRecord).id,
    name: (s) => (s.v.repo as RepoRecord).name,
    nameWithOwner: (s) => `${(s.v.repo as RepoRecord).owner}/${(s.v.repo as RepoRecord).name}`,
    owner: (s) => gobj('User', { login: (s.v.repo as RepoRecord).owner, id: VIEWER_ID }),
    defaultBranchRef: (s) => gobj('Ref', { name: defaultBranchName(s.v.repo as RepoRecord) }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    isPrivate: (s) => (s.v.repo as RepoRecord).isPrivate,
    description: (s) => (s.v.repo as RepoRecord).description,
    issue: (s, args) => {
      const repo = s.v.repo as RepoRecord;
      const issue = repo.issues.get(Number(args.number));
      return issue === undefined ? null : gobj('Issue', { repo, issue });
    },
    issues: (s, args) => issueConnection(s.v.repo as RepoRecord, args),
    pullRequest: (s, args) => {
      const repo = s.v.repo as RepoRecord;
      const pull = repo.pulls.get(Number(args.number));
      return pull === undefined ? null : gobj('PullRequest', { repo, pull });
    },
    pullRequests: (s, args) => pullConnection(s.v.repo as RepoRecord, args),
  },
  Issue: {
    id: (s) => issueGid(s.v.repo as RepoRecord, s.v.issue as IssueRecord),
    number: (s) => (s.v.issue as IssueRecord).number,
    title: (s) => (s.v.issue as IssueRecord).title,
    body: (s) => (s.v.issue as IssueRecord).body,
    state: (s) => (s.v.issue as IssueRecord).state.toUpperCase(),
    repository: (s) => gobj('Repository', { repo: s.v.repo as RepoRecord }),
  },
  PullRequest: {
    id: (s) => pullGid(s.v.repo as RepoRecord, s.v.pull as PullRecord),
    number: (s) => (s.v.pull as PullRecord).number,
    title: (s) => (s.v.pull as PullRecord).title,
    body: (s) => (s.v.pull as PullRecord).body,
    state: (s) => {
      const pull = s.v.pull as PullRecord;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (s) => (s.v.pull as PullRecord).merged,
    mergeable: (s) => {
      const repo = s.v.repo as RepoRecord;
      const pull = s.v.pull as PullRecord;
      if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
      return pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
    },
    headRefName: (s) => (s.v.pull as PullRecord).headRef,
    baseRefName: (s) => (s.v.pull as PullRecord).baseRef,
    headRef: (s) => gobj('Ref', { name: (s.v.pull as PullRecord).headRef }),
    baseRef: (s) => gobj('Ref', { name: (s.v.pull as PullRecord).baseRef }),
    files: (s, args) => {
      const repo = s.v.repo as RepoRecord;
      const pull = s.v.pull as PullRecord;
      const headTip = branchTip(repo, pull.headRef);
      const baseTip = branchTip(repo, pull.baseRef);
      let changes: FileChange[] = [];
      if (headTip !== null && baseTip !== null) {
        changes = diffFlats(flatOfCommit(mergeBase(headTip, baseTip)), flatOfCommit(headTip));
      }
      const first = typeof args.first === 'number' ? args.first : changes.length;
      return gobj('PullRequestFileConnection', {
        nodes: changes.slice(0, first).map((change) => gobj('ChangedFile', { change })),
      });
    },
  },
  Ref: {
    name: (s) => s.v.name as string,
    prefix: () => 'refs/heads/',
  },
  IssueConnection: {
    nodes: (s) => s.v.nodes as GObj[],
    pageInfo: (s) => gobj('PageInfo', s.v.pageInfo as Record<string, unknown>),
    totalCount: (s) => (s.v.nodes as GObj[]).length,
  },
  PullRequestConnection: {
    nodes: (s) => s.v.nodes as GObj[],
    pageInfo: (s) => gobj('PageInfo', s.v.pageInfo as Record<string, unknown>),
    totalCount: (s) => (s.v.nodes as GObj[]).length,
  },
  PullRequestFileConnection: {
    nodes: (s) => s.v.nodes as GObj[],
    totalCount: (s) => (s.v.nodes as GObj[]).length,
  },
  ChangedFile: {
    path: (s) => (s.v.change as FileChange).filename,
    additions: (s) => (s.v.change as FileChange).additions,
    deletions: (s) => (s.v.change as FileChange).deletions,
    changeType: (s) => ((s.v.change as FileChange).status === 'added' ? 'ADDED' : (s.v.change as FileChange).status === 'removed' ? 'DELETED' : 'MODIFIED'),
  },
  PageInfo: {
    hasNextPage: (s) => s.v.hasNextPage as boolean,
    hasPreviousPage: () => false,
    startCursor: (s) => s.v.endCursor as string,
    endCursor: (s) => s.v.endCursor as string,
  },
  IssueComment: {
    id: (s) => encodeGid(`C${(s.v.repo as RepoRecord).id}:${(s.v.issue as IssueRecord).number}:${(s.v.comment as { id: number }).id}`),
    body: (s) => (s.v.comment as { body: string }).body,
  },
  CreateIssuePayload: { issue: (s) => s.v.issue as GObj | null },
  CloseIssuePayload: { issue: (s) => s.v.issue as GObj | null },
  CreatePullRequestPayload: { pullRequest: (s) => s.v.pullRequest as GObj | null },
  MergePullRequestPayload: { pullRequest: (s) => s.v.pullRequest as GObj | null },
  AddCommentPayload: { commentEdge: (s) => s.v.commentEdge as GObj | null },
  CommentEdge: { node: (s) => s.v.node as GObj },
  __Type: {
    name: (s) => s.v.name as string,
    kind: (s) => (GQL_TYPE_ENUMS[s.v.name as string] !== undefined ? 'ENUM' : 'OBJECT'),
    fields: (s) => {
      const fields = GQL_TYPE_FIELDS[s.v.name as string];
      return fields === undefined ? null : fields.map((name) => gobj('__Field', { name }));
    },
    enumValues: (s) => {
      const values = GQL_TYPE_ENUMS[s.v.name as string];
      return values === undefined ? null : values.map((name) => gobj('__EnumValue', { name }));
    },
  },
  __Field: {
    name: (s) => s.v.name as string,
    description: () => null,
  },
  __EnumValue: {
    name: (s) => s.v.name as string,
    description: () => null,
  },
};

const GQL_TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'rateLimit', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'isPrivate', 'description', 'issue', 'issues', 'pullRequests', 'pullRequest',
    'createdAt', 'updatedAt', 'url',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'repository', 'comments', 'labels', 'createdAt', 'updatedAt', 'url'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt', 'url',
  ],
  Ref: ['name', 'prefix', 'target'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
};

const GQL_TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

function executeSelection(
  typeName: string,
  source: GObj,
  selection: readonly GqlSelection[],
  ctx: GqlContext,
  fragments: ReadonlyMap<string, GqlSelection[]>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const item of selection) {
    if (item.kind === 'inline') {
      const inner = item.type.startsWith('fragment:') ? fragments.get(item.type.slice('fragment:'.length)) ?? [] : item.selection;
      if (item.type === typeName || item.type.startsWith('fragment:')) {
        Object.assign(out, executeSelection(typeName, source, inner, ctx, fragments));
      }
      continue;
    }
    const field = item.field;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const resolver = GQL_RESOLVERS[typeName]?.[field.name];
    if (resolver === undefined) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [name, value] of field.args) args[name] = resolveValue(value, ctx.variables);
    const value = resolver(source, args, ctx);
    out[key] = completeValue(value, field, ctx, fragments);
  }
  return out;
}

function completeValue(
  value: unknown,
  field: GqlFieldNode,
  ctx: GqlContext,
  fragments: ReadonlyMap<string, GqlSelection[]>,
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(entry, field, ctx, fragments));
  if (typeof value === 'object' && 't' in value && 'v' in value) {
    const object = value as GObj;
    if (field.selection === null) return null;
    return executeSelection(object.t, object, field.selection, ctx, fragments);
  }
  return value;
}

function runGraphQL(body: unknown): { status: number; payload: unknown } {
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (entry === null || typeof entry !== 'object') return { errors: [{ message: 'Invalid GraphQL document.' }] };
    const record = entry as { query?: unknown; variables?: unknown };
    if (typeof record.query !== 'string') return { errors: [{ message: 'No GraphQL query was provided.' }] };
    const ctx: GqlContext = {
      variables: (record.variables ?? {}) as Record<string, unknown>,
      errors: [],
    };
    try {
      const { operations, fragments } = parseGraphQL(record.query);
      const operation = operations[0];
      if (operation === undefined) return { errors: [{ message: 'No operation found.' }] };
      const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
      const data = executeSelection(rootType, gobj(rootType, {}), operation.selection, ctx, fragments);
      const result: Record<string, unknown> = { data };
      if (ctx.errors.length > 0) result.errors = ctx.errors;
      return result;
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : 'GraphQL execution failed.' }] };
    }
  };
  if (Array.isArray(body)) return { status: 200, payload: body.map(runOne) };
  return { status: 200, payload: runOne(body) };
}

// ---------------------------------------------------------------- MCP

const MCP_SERVER_INFO = { name: 'quickforge-mcp', version: '1.0.0' };
const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function toolSchema(properties: Record<string, unknown>, required: readonly string[]): Record<string, unknown> {
  return { type: 'object', properties, required: [...required] };
}

const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: toolSchema(
      {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      ['name'],
    ),
  },
  {
    name: 'get_repo',
    description: 'Get a repository by its owner and name.',
    inputSchema: toolSchema(
      {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      ['owner', 'repo'],
    ),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: toolSchema(
      {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      ['owner', 'repo', 'title'],
    ),
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: toolSchema(
      {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      ['owner', 'repo'],
    ),
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: toolSchema(
      {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      ['owner', 'repo', 'title', 'head', 'base'],
    ),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch.',
    inputSchema: toolSchema(
      {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      ['owner', 'repo', 'pull_number'],
    ),
  },
];

function mcpToolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function mcpToolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function runMcpTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const repoOf = (): RepoRecord | null => findRepo(String(args.owner ?? ''), String(args.repo ?? ''));
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name ?? '');
      if (repoName === '') return mcpToolError('name is required');
      if (findRepo(VIEWER_LOGIN, repoName) !== null) return mcpToolError(`repository ${repoName} already exists`);
      const repo = createRepo(VIEWER_LOGIN, repoName, args.private === true, String(args.description ?? ''));
      return mcpToolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = repoOf();
      if (repo === null) return mcpToolError('repository not found');
      return mcpToolResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = repoOf();
      if (repo === null) return mcpToolError('repository not found');
      const issue: IssueRecord = {
        number: repo.nextNumber++,
        restId: nextRestId++,
        title: String(args.title ?? ''),
        body: String(args.body ?? ''),
        state: 'open',
        labels: [],
        comments: [],
      };
      repo.issues.set(issue.number, issue);
      return mcpToolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = repoOf();
      if (repo === null) return mcpToolError('repository not found');
      const state = String(args.state ?? 'open');
      let list = [...repo.issues.values()].sort((a, b) => a.number - b.number);
      if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
      return mcpToolResult(list.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = repoOf();
      if (repo === null) return mcpToolError('repository not found');
      const head = String(args.head ?? '');
      const base = String(args.base ?? '');
      if (branchTip(repo, head) === null || branchTip(repo, base) === null) {
        return mcpToolError('invalid head or base branch');
      }
      const pull: PullRecord = {
        number: repo.nextNumber++,
        restId: nextRestId++,
        title: String(args.title ?? ''),
        body: String(args.body ?? ''),
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        baseRef: base,
      };
      repo.pulls.set(pull.number, pull);
      return mcpToolResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = repoOf();
      if (repo === null) return mcpToolError('repository not found');
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) return mcpToolError('pull request not found');
      if (pull.state !== 'open' || pull.merged) return mcpToolError('pull request is not open');
      const sha = mergePull(repo, pull);
      if (sha === null) return mcpToolError('pull request is not mergeable');
      return mcpToolResult({ number: pull.number, merged: true, state: 'closed', sha });
    }
    default:
      return mcpToolError(`unknown tool ${name}`);
  }
}

function handleMcp(res: ServerResponse, bodyText: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const dispatch = (message: Record<string, unknown>): Record<string, unknown> | null => {
    const id = message.id;
    const method = String(message.method ?? '');
    const params = (message.params ?? {}) as Record<string, unknown>;
    if (id === undefined) return null; // a notification: nothing to answer
    const ok = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id, result });
    const failWith = (code: number, text: string): Record<string, unknown> => ({
      jsonrpc: '2.0',
      id,
      error: { code, message: text },
    });
    switch (method) {
      case 'server/discover':
        return ok({
          resultType: 'complete',
          supportedVersions: MCP_SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          serverInfo: MCP_SERVER_INFO,
          _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
        });
      case 'initialize': {
        const offered = String(params.protocolVersion ?? '');
        const chosen = MCP_SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
        return ok({ protocolVersion: chosen, capabilities: { tools: {} }, serverInfo: MCP_SERVER_INFO });
      }
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: MCP_TOOLS });
      case 'tools/call': {
        const toolName = String(params.name ?? '');
        const tool = MCP_TOOLS.find((candidate) => candidate.name === toolName);
        if (tool === undefined) return failWith(-32602, `unknown tool: ${toolName}`);
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        const schema = tool.inputSchema as { required?: string[] };
        for (const required of schema.required ?? []) {
          if (args[required] === undefined || args[required] === null || args[required] === '') {
            return failWith(-32602, `missing required argument: ${required}`);
          }
        }
        return ok(runMcpTool(toolName, args));
      }
      default:
        return failWith(-32601, `method not found: ${method}`);
    }
  };
  if (Array.isArray(parsed)) {
    const answers = parsed
      .map((entry) => dispatch((entry ?? {}) as Record<string, unknown>))
      .filter((entry) => entry !== null);
    if (answers.length === 0) {
      res.writeHead(202, { 'content-length': 0 });
      res.end();
      return;
    }
    sendJson(res, 200, answers);
    return;
  }
  const answer = dispatch((parsed ?? {}) as Record<string, unknown>);
  if (answer === null) {
    res.writeHead(202, { 'content-length': 0 });
    res.end();
    return;
  }
  sendJson(res, 200, answer);
}

// ---------------------------------------------------------------- HTTP server and routing

function authorised(req: IncomingMessage): boolean {
  if (SHOP_TOKEN === '') return true;
  return req.headers.authorization === `Bearer ${SHOP_TOKEN}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const rawUrl = req.url ?? '/';
  const qIndex = rawUrl.indexOf('?');
  const rawPath = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
  const query = new URLSearchParams(qIndex === -1 ? '' : rawUrl.slice(qIndex + 1));
  const segments = rawPath.split('/').filter((piece) => piece !== '').map(decodeSegment);

  if (method === 'GET' && rawPath === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // MCP endpoint.
  if (segments[0] === 'mcp' && segments.length === 1) {
    if (!authorised(req)) return sendJson(res, 401, { message: 'Unauthorized' });
    const body = await readBody(req);
    handleMcp(res, body.toString('utf8'));
    return;
  }

  // GraphQL endpoint.
  if (segments[0] === 'api' && segments[1] === 'graphql') {
    if (!authorised(req)) return sendJson(res, 401, { message: 'Bad credentials' });
    const body = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8')) as unknown;
    } catch {
      return sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    }
    const { status, payload } = runGraphQL(parsed);
    return sendJson(res, status, payload);
  }

  // REST v3.
  if (segments[0] === 'api' && segments[1] === 'v3') {
    const restSegments = segments.slice(2);
    const isPublic = restSegments.length === 0 || (restSegments.length === 1 && restSegments[0] === 'meta');
    if (!isPublic && !authorised(req)) {
      res.setHeader('x-github-request-id', `QF-${++requestCounter}`);
      return sendJson(res, 401, { message: 'Requires authentication' });
    }
    let body: Record<string, unknown> = {};
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          const parsedBody = JSON.parse(raw.toString('utf8')) as unknown;
          if (parsedBody === null || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
            return sendJson(res, 400, { message: 'Problems parsing JSON' });
          }
          body = parsedBody as Record<string, unknown>;
        } catch {
          res.setHeader('x-github-request-id', `QF-${++requestCounter}`);
          return sendJson(res, 400, { message: 'Problems parsing JSON' });
        }
      }
    }
    res.setHeader('x-github-request-id', `QF-${++requestCounter}`);
    handleRest({ req, res, query, body }, restSegments);
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  if (segments.length >= 3 && segments[1]!.endsWith('.git')) {
    const owner = segments[0]!;
    const repoName = segments[1]!.slice(0, -'.git'.length);
    const tail = segments.slice(2);
    if (!authorised(req)) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('unauthorized\n');
      return;
    }
    const repo = findRepo(owner, repoName);
    if (repo === null) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found\n');
      return;
    }
    if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
      const service = query.get('service') ?? '';
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('bad service\n');
        return;
      }
      handleAdvertise(res, repo, service, req.headers['git-protocol'] ?? '');
      return;
    }
    if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
      const body = await readBody(req);
      const { command } = parseV2Command(body);
      if (command === 'ls-refs') {
        const { args } = parseV2Command(body);
        handleLsRefs(res, repo, args);
      } else if (command === 'fetch') {
        const { args } = parseV2Command(body);
        handleFetchV2(res, repo, args);
      } else {
        handleFetchV0(res, repo, body);
      }
      return;
    }
    if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
      const body = await readBody(req);
      handleReceivePack(res, repo, body);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found\n');
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

/** Build the forge's HTTP server (binding is the caller's job). */
export function createApp(): Server {
  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ message: err instanceof Error ? err.message : 'internal error' }));
    });
  });
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 65_000;
  return server;
}
