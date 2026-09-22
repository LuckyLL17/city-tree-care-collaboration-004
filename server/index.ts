import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

type Item = { id: string; createdAt: string; [key: string]: string };

type PublicReport = {
  id: string;
  code: string; // 可追踪反馈编号
  location: string; // 树木位置
  description: string; // 问题描述
  contact: string; // 联系方式（可空，即匿名）
  status: '待审核' | '已采纳' | '已驳回';
  rejectReason?: string; // 驳回原因
  duplicateOf?: string; // 疑似重复的已有反馈编号
  linkedReportId?: string; // 采纳后转入内部「异常反馈」的记录 id
  createdAt: string;
  reviewedAt?: string;
};

const PORT = Number(process.env.PORT || 4001);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

// ---------- 内部业务模块（树木档案 / 异常反馈 / 巡检任务） ----------
const allowed = ['trees', 'reports', 'inspections'];
const states = ['待派单', '待执行', '处理中', '已完成'];
const seed: Record<string, Record<string, string>[]> = {
  trees: [
    { species: '香樟', location: '青松路18号', health: '良好', lastInspection: '2026-09-10' },
    { species: '银杏', location: '滨河公园东门', health: '需关注', lastInspection: '2026-09-12' },
  ],
  reports: [
    { tree: '银杏', reporter: '周宁', issue: '树冠部分枝条枯黄', source: '居民上报 FB-20260920-A7K2', status: '待派单' },
  ],
  inspections: [{ tree: '香樟', inspector: '养护一组', date: '2026-09-23', status: '待执行' }],
};
const data: Record<string, Item[]> = Object.fromEntries(
  allowed.map((key) => [key, (seed[key] || []).map((item) => ({ ...item, id: randomUUID(), createdAt: new Date().toISOString() }))]),
);

// ---------- 居民公开上报数据 ----------
const publicReports: PublicReport[] = [];
function seedPublicReports() {
  const t = (d: string) => new Date(d).toISOString();
  publicReports.push(
    { id: randomUUID(), code: 'FB-20260920-A7K2', location: '滨河公园东门', description: '银杏树树冠部分枝条枯黄，疑似病虫害，请尽快处理。', contact: '13800001234', status: '已采纳', linkedReportId: data.reports[0]?.id, createdAt: t('2026-09-20T09:12:00'), reviewedAt: t('2026-09-20T14:30:00') },
    { id: randomUUID(), code: 'FB-20260921-Q3M8', location: '青松路18号', description: '人行道旁香樟树大量落叶，树皮出现开裂。', contact: '', status: '待审核', createdAt: t('2026-09-21T08:40:00') },
    { id: randomUUID(), code: 'FB-20260921-W9T4', location: '青松路18号', description: '香樟树皮开裂、落叶严重，担心倒伏。', contact: 'zhou@example.com', status: '待审核', duplicateOf: 'FB-20260921-Q3M8', createdAt: t('2026-09-21T10:05:00') },
    { id: randomUUID(), code: 'FB-20260919-Z5X1', location: '梧桐里小区北门', description: '树木遮挡采光，要求直接砍伐。', contact: '13900005678', status: '已驳回', rejectReason: '该树木属小区内部绿化，不在公共养护范围，已转交物业处理。', createdAt: t('2026-09-19T16:20:00'), reviewedAt: t('2026-09-19T18:02:00') },
  );
}
seedPublicReports();

// ---------- 简易限流（内存滑动窗口，防恶意重复请求） ----------
const buckets = new Map<string, number[]>();
function hitLimit(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    buckets.set(key, hits);
    return true;
  }
  hits.push(now);
  buckets.set(key, hits);
  return false;
}
function clientIp(req: IncomingMessage) {
  const fwd = req.headers['x-forwarded-for'];
  return (typeof fwd === 'string' && fwd.split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';
}

// ---------- 位置 / 描述相似度（重复上报合并提示） ----------
function normalize(text: string) {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}
function bigrams(text: string) {
  const set = new Set<string>();
  if (text.length === 1) set.add(text);
  for (let i = 0; i < text.length - 1; i++) set.add(text.slice(i, i + 2));
  return set;
}
function similarity(a: string, b: string) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return (2 * inter) / (A.size + B.size);
}
function findDuplicate(location: string, description: string) {
  const loc = normalize(location);
  const desc = normalize(description);
  return publicReports.find((r) => {
    if (r.status === '已驳回') return false;
    const rLoc = normalize(r.location);
    const samePlace = rLoc === loc || rLoc.includes(loc) || loc.includes(rLoc);
    return samePlace && similarity(desc, normalize(r.description)) >= 0.5;
  });
}

// ---------- 反馈编号 ----------
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去掉易混淆字符
function genCode() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  let code = '';
  do {
    let suffix = '';
    for (let i = 0; i < 4; i++) suffix += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    code = `FB-${ymd}-${suffix}`;
  } while (publicReports.some((r) => r.code === code));
  return code;
}

// ---------- 提交校验 ----------
function validateSubmission(payload: Record<string, unknown>) {
  const location = String(payload.location ?? '').trim();
  const description = String(payload.description ?? '').trim();
  const contact = String(payload.contact ?? '').trim();
  if (location.length < 2 || location.length > 120) return { error: '树木位置需为 2-120 个字符' };
  if (description.length < 5 || description.length > 500) return { error: '问题描述需为 5-500 个字符' };
  if (contact) {
    const ok = /^1[3-9]\d{9}$/.test(contact) || /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(contact) || /^0\d{2,3}-?\d{7,8}$/.test(contact);
    if (!ok) return { error: '联系方式格式不正确，请填写手机号、座机或邮箱，也可留空匿名提交' };
  }
  return { location, description, contact };
}

// 居民可见的字段（不暴露联系方式、内部关联等管理数据）
function publicView(r: PublicReport) {
  return {
    code: r.code,
    location: r.location,
    description: r.description,
    status: r.status,
    rejectReason: r.status === '已驳回' ? r.rejectReason : undefined,
    createdAt: r.createdAt,
    reviewedAt: r.reviewedAt,
  };
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}
async function body(req: IncomingMessage) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw new Error('请求体过大');
  }
  return raw ? JSON.parse(raw) : {};
}
function parts(url: string) {
  return new URL(url, 'http://localhost').pathname.split('/').filter(Boolean);
}

const server = createServer(async (req, res) => {
  try {
    const p = parts(req.url || '/');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS' });
      return res.end();
    }
    if (req.method === 'GET' && p[0] === 'api' && p[1] === 'health') {
      return json(res, 200, { status: 'ok', project: 'city-tree-care-collaboration', workflow: '建立树木档案 → 安排巡检 → 记录异常 → 派发养护 → 完成复核' });
    }
    if (p[0] !== 'api') {
      if (req.method === 'GET') {
        const html = await readFile(join(root, 'index.html'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      return json(res, 404, { error: 'Not found' });
    }

    // ----- 居民公开接口（匿名可用，不暴露内部管理数据） -----
    if (p[1] === 'public' && p[2] === 'reports') {
      if (req.method === 'POST' && p.length === 3) {
        if (hitLimit(`submit:${clientIp(req)}`, 5, 10 * 60 * 1000)) {
          return json(res, 429, { error: '提交过于频繁，请 10 分钟后再试' });
        }
        const parsed = validateSubmission(await body(req));
        if ('error' in parsed) return json(res, 400, { error: parsed.error });
        const dup = findDuplicate(parsed.location, parsed.description);
        const report: PublicReport = {
          id: randomUUID(),
          code: genCode(),
          ...parsed,
          status: '待审核',
          duplicateOf: dup?.code,
          createdAt: new Date().toISOString(),
        };
        publicReports.push(report);
        return json(res, 201, {
          ...publicView(report),
          duplicateOf: dup?.code,
          message: dup
            ? `检测到与反馈编号 ${dup.code} 的位置和描述相近，已为您合并关联，处理进度将同步更新。`
            : '提交成功，请保存反馈编号用于查询处理进度。',
        });
      }
      if (req.method === 'GET' && p.length === 4) {
        if (hitLimit(`track:${clientIp(req)}`, 30, 60 * 1000)) {
          return json(res, 429, { error: '查询过于频繁，请稍后再试' });
        }
        const report = publicReports.find((r) => r.code === decodeURIComponent(p[3]).toUpperCase());
        if (!report) return json(res, 404, { error: '反馈编号不存在，请核对后重试' });
        return json(res, 200, publicView(report));
      }
      return json(res, 405, { error: '不支持的操作' });
    }

    // ----- 管理端：居民上报审核 -----
    if (p[1] === 'public-reports') {
      if (req.method === 'GET' && p.length === 2) return json(res, 200, publicReports);
      const report = publicReports.find((r) => r.id === p[2]);
      if (!report) return json(res, 404, { error: '反馈不存在' });
      if (req.method === 'POST' && p[3] === 'review') {
        if (report.status !== '待审核') return json(res, 409, { error: '该反馈已完成审核，请勿重复操作' });
        const { action, reason } = await body(req);
        if (action === 'accept') {
          report.status = '已采纳';
          report.reviewedAt = new Date().toISOString();
          const linked: Item = {
            id: randomUUID(),
            createdAt: report.reviewedAt,
            tree: report.location,
            reporter: report.contact || '匿名居民',
            issue: report.description,
            source: `居民上报 ${report.code}`,
            status: '待派单',
          };
          data.reports.push(linked);
          report.linkedReportId = linked.id;
          return json(res, 200, { report, linkedReport: linked });
        }
        if (action === 'reject') {
          const text = String(reason ?? '').trim();
          if (!text) return json(res, 400, { error: '驳回时必须填写驳回原因' });
          if (text.length > 200) return json(res, 400, { error: '驳回原因不能超过 200 字' });
          report.status = '已驳回';
          report.rejectReason = text;
          report.reviewedAt = new Date().toISOString();
          return json(res, 200, { report });
        }
        return json(res, 400, { error: '不支持的审核操作' });
      }
      return json(res, 405, { error: '不支持的操作' });
    }

    // ----- 内部通用资源接口 -----
    const resource = p[1];
    if (!resource || !allowed.includes(resource)) return json(res, 404, { error: '未知业务模块' });
    if (req.method === 'GET' && p.length === 2) return json(res, 200, data[resource]);
    if (req.method === 'POST' && p.length === 2) {
      const item = { ...(await body(req)), id: randomUUID(), createdAt: new Date().toISOString() } as Item;
      data[resource].push(item);
      return json(res, 201, item);
    }
    const item = data[resource].find((x) => x.id === p[2]);
    if (!item) return json(res, 404, { error: '记录不存在' });
    if (req.method === 'POST' && p[3] === 'transition') {
      const next = (await body(req)).status;
      if (!states.includes(next)) return json(res, 400, { error: '不支持的状态' });
      item.status = next;
      return json(res, 200, item);
    }
    if (req.method === 'PATCH' && p.length === 3) {
      Object.assign(item, await body(req));
      return json(res, 200, item);
    }
    if (req.method === 'DELETE' && p.length === 3) {
      data[resource] = data[resource].filter((x) => x.id !== item.id);
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: '不支持的操作' });
  } catch (error) {
    return json(res, 500, { error: error instanceof Error ? error.message : '服务器错误' });
  }
});
server.listen(PORT, () => console.log(`API server running at http://localhost:${PORT}`));
