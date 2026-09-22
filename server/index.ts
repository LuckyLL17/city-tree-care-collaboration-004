import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Item = { id: string; createdAt: string; [key: string]: string };

const PORT = Number(process.env.PORT || 4001);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

/* ---------------- 内部业务模块（树木档案 / 异常反馈 / 巡检任务） ---------------- */

const allowed = ['trees', 'reports', 'inspections'];
const states = ['待派单', '待执行', '处理中', '已完成'];
const seed: Record<string, Record<string, string>[]> = {
  trees: [
    { species: '香樟', location: '青松路18号', health: '良好', lastInspection: '2026-09-10' },
    { species: '银杏', location: '滨河公园东门', health: '需关注', lastInspection: '2026-09-12' },
  ],
  reports: [{ tree: '银杏', reporter: '周宁', issue: '树冠部分枝条枯黄', status: '待派单', source: '内部登记' }],
  inspections: [{ tree: '香樟', inspector: '养护一组', date: '2026-09-23', status: '待执行' }],
};
const data: Record<string, Item[]> = Object.fromEntries(
  allowed.map((key) => [key, (seed[key] || []).map((item) => ({ ...item, id: randomUUID(), createdAt: new Date().toISOString() }))]),
);

/* ---------------- 居民公开上报 ---------------- */

type ReviewStatus = '待审核' | '已采纳' | '已驳回';

interface PublicReport {
  id: string;
  code: string; // 可追踪反馈编号，居民凭它查询进度
  location: string; // 树木位置
  description: string; // 问题描述
  contact: string; // 联系方式（可匿名留空）
  status: ReviewStatus;
  rejectReason: string; // 驳回原因（仅驳回时填写）
  reportId: string; // 采纳后联动生成的内部异常反馈 id
  createdAt: string;
  reviewedAt: string;
}

const publicReports: PublicReport[] = [];
const reviewStatuses: ReviewStatus[] = ['待审核', '已采纳', '已驳回'];

// 匿名提交限流：同一 IP 10 分钟内最多 5 次，且两次提交至少间隔 10 秒
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX_PER_WINDOW = 5;
const RATE_MIN_INTERVAL_MS = 10 * 1000;
const submitLog = new Map<string, number[]>();

function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function checkRateLimit(ip: string): { ok: true } | { ok: false; retryAfter: number } {
  const now = Date.now();
  const hits = (submitLog.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  const last = hits[hits.length - 1];
  if (last !== undefined && now - last < RATE_MIN_INTERVAL_MS) {
    return { ok: false, retryAfter: Math.ceil((RATE_MIN_INTERVAL_MS - (now - last)) / 1000) };
  }
  if (hits.length >= RATE_MAX_PER_WINDOW) {
    return { ok: false, retryAfter: Math.ceil((RATE_WINDOW_MS - (now - hits[0])) / 1000) };
  }
  hits.push(now);
  submitLog.set(ip, hits);
  return { ok: true };
}

const CONTACT_PATTERN = /^(1[3-9]\d{9}|0\d{2,3}-?\d{7,8}|[\w.+-]+@[\w-]+\.[\w.]+)$/;

function validatePublicInput(
  raw: Record<string, unknown>,
): { ok: true; value: { location: string; description: string; contact: string } } | { ok: false; error: string } {
  const location = typeof raw.location === 'string' ? raw.location.trim() : '';
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  const contact = typeof raw.contact === 'string' ? raw.contact.trim() : '';
  if (location.length < 2 || location.length > 120) return { ok: false, error: '树木位置必填，长度需在 2-120 个字符之间' };
  if (description.length < 5 || description.length > 500) return { ok: false, error: '问题描述必填，长度需在 5-500 个字符之间' };
  if (contact && (contact.length > 50 || !CONTACT_PATTERN.test(contact))) {
    return { ok: false, error: '联系方式格式不正确，请填写手机号、座机号或邮箱，也可留空匿名提交' };
  }
  return { ok: true, value: { location, description, contact } };
}

// 反馈编号：FB-日期-随机后缀（剔除易混淆字符），全库唯一
function trackingCode(): string {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    let suffix = '';
    for (let i = 0; i < 4; i++) suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
    code = `FB-${ymd}-${suffix}`;
  } while (publicReports.some((r) => r.code === code));
  return code;
}

/* -------- 重复上报合并检测：同一位置（归一化后相同）+ 描述相近 -------- */

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function bigrams(s: string): Set<string> {
  const grams = new Set<string>();
  if (s.length === 1) grams.add(s);
  for (let i = 0; i + 2 <= s.length; i++) grams.add(s.slice(i, i + 2));
  return grams;
}

function isSimilarDescription(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length >= 4 && longer.includes(shorter)) return true;
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return false;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size) >= 0.5; // Dice 系数
}

function findDuplicate(location: string, description: string): PublicReport | undefined {
  const loc = normalizeText(location);
  const desc = normalizeText(description);
  return publicReports.find(
    (r) => r.status !== '已驳回' && normalizeText(r.location) === loc && isSimilarDescription(desc, normalizeText(r.description)),
  );
}

/* ---------------- 基础工具 ---------------- */

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage, limit = 32 * 1024): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw new HttpError(413, '请求体过大');
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, '请求体不是合法的 JSON');
  }
}

// 居民查询进度时只暴露公开字段，不包含联系方式与内部关联信息
function publicView(r: PublicReport) {
  return {
    code: r.code,
    location: r.location,
    description: r.description,
    status: r.status,
    rejectReason: r.rejectReason || undefined,
    createdAt: r.createdAt,
    reviewedAt: r.reviewedAt || undefined,
  };
}

/* ---------------- 公开接口（居民侧，无需登录） ---------------- */

async function submitPublicReport(req: IncomingMessage, res: ServerResponse) {
  const rate = checkRateLimit(clientIp(req));
  if (!rate.ok) {
    res.setHeader('Retry-After', String(rate.retryAfter));
    return json(res, 429, { error: `提交过于频繁，请约 ${rate.retryAfter} 秒后再试`, retryAfter: rate.retryAfter });
  }
  const parsed = validatePublicInput(await body(req));
  if (!parsed.ok) return json(res, 400, { error: parsed.error });
  const { location, description, contact } = parsed.value;

  const duplicate = findDuplicate(location, description);
  if (duplicate) {
    return json(res, 200, {
      merged: true,
      code: duplicate.code,
      message: `该位置已有相近问题的反馈（编号 ${duplicate.code}），已为您合并到现有反馈，无需重复提交。可使用该编号查询处理进度。`,
    });
  }

  const report: PublicReport = {
    id: randomUUID(),
    code: trackingCode(),
    location,
    description,
    contact,
    status: '待审核',
    rejectReason: '',
    reportId: '',
    createdAt: new Date().toISOString(),
    reviewedAt: '',
  };
  publicReports.push(report);
  return json(res, 201, { merged: false, code: report.code, status: report.status, message: '提交成功，请保存反馈编号以便查询处理进度' });
}

function queryPublicReport(res: ServerResponse, rawCode: string) {
  const code = decodeURIComponent(rawCode).trim().toUpperCase();
  const report = publicReports.find((r) => r.code === code);
  if (!report) return json(res, 404, { error: '未找到该反馈编号，请核对后重试' });
  return json(res, 200, publicView(report));
}

/* ---------------- 管理端审核接口 ---------------- */

function listPublicReports(res: ServerResponse, url: URL) {
  const status = url.searchParams.get('status');
  if (status && !reviewStatuses.includes(status as ReviewStatus)) {
    return json(res, 400, { error: `不支持的审核状态，仅支持：${reviewStatuses.join(' / ')}` });
  }
  const list = publicReports
    .filter((r) => !status || r.status === status)
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return json(res, 200, list);
}

async function reviewPublicReport(req: IncomingMessage, res: ServerResponse, id: string) {
  const report = publicReports.find((r) => r.id === id);
  if (!report) return json(res, 404, { error: '上报记录不存在' });
  if (report.status !== '待审核') {
    return json(res, 409, { error: `该上报已完成审核（当前状态：${report.status}），不能重复审核` });
  }
  const payload = await body(req);
  const action = typeof payload.action === 'string' ? payload.action : '';

  if (action === 'adopt') {
    // 采纳后联动内部异常反馈列表，生成待派单记录进入既有流程
    const linked: Item = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      tree: report.location,
      reporter: report.contact ? `居民（${report.contact}）` : '匿名居民',
      issue: report.description,
      status: states[0],
      source: '居民上报',
      publicCode: report.code,
    };
    data.reports.push(linked);
    report.status = '已采纳';
    report.reportId = linked.id;
    report.reviewedAt = new Date().toISOString();
    return json(res, 200, { report, linkedReport: linked });
  }

  if (action === 'reject') {
    const reason = typeof payload.reason === 'string' ? payload.reason.trim() : '';
    if (reason.length < 2 || reason.length > 200) return json(res, 400, { error: '驳回原因必填，长度需在 2-200 个字符之间' });
    report.status = '已驳回';
    report.rejectReason = reason;
    report.reviewedAt = new Date().toISOString();
    return json(res, 200, { report });
  }

  return json(res, 400, { error: '不支持的审核操作，action 仅支持 adopt / reject' });
}

/* ---------------- 路由 ---------------- */

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const p = url.pathname.split('/').filter(Boolean);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      });
      return res.end();
    }

    if (req.method === 'GET' && p[0] === 'api' && p[1] === 'health') {
      return json(res, 200, {
        status: 'ok',
        project: 'city-tree-care-collaboration',
        workflow: '建立树木档案 → 安排巡检 → 记录异常 → 派发养护 → 完成复核',
      });
    }

    if (p[0] !== 'api') {
      if (req.method === 'GET') {
        const html = await readFile(join(root, 'index.html'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      return json(res, 404, { error: 'Not found' });
    }

    // 居民公开入口：匿名提交与进度查询（不暴露内部管理数据）
    if (p[1] === 'public' && p[2] === 'reports') {
      if (req.method === 'POST' && p.length === 3) return await submitPublicReport(req, res);
      if (req.method === 'GET' && p.length === 4) return queryPublicReport(res, p[3]);
      return json(res, 405, { error: '不支持的操作' });
    }

    // 管理端：居民上报审核
    if (p[1] === 'public-reports') {
      if (req.method === 'GET' && p.length === 2) return listPublicReports(res, url);
      if (req.method === 'POST' && p.length === 4 && p[3] === 'review') return await reviewPublicReport(req, res, p[2]);
      return json(res, 405, { error: '不支持的操作' });
    }

    const resource = p[1];
    if (!resource || !allowed.includes(resource)) return json(res, 404, { error: '未知业务模块' });

    if (req.method === 'GET' && p.length === 2) return json(res, 200, data[resource]);

    if (req.method === 'POST' && p.length === 2) {
      const item = { ...(await body(req)), id: randomUUID(), createdAt: new Date().toISOString() } as Item;
      if (resource === 'reports' && !item.source) item.source = '内部登记';
      data[resource].push(item);
      return json(res, 201, item);
    }

    const item = data[resource].find((x) => x.id === p[2]);
    if (!item) return json(res, 404, { error: '记录不存在' });

    if (req.method === 'POST' && p[3] === 'transition') {
      const next = (await body(req)).status;
      if (typeof next !== 'string' || !states.includes(next)) return json(res, 400, { error: '不支持的状态' });
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
    if (error instanceof HttpError) return json(res, error.status, { error: error.message });
    return json(res, 500, { error: error instanceof Error ? error.message : '服务器错误' });
  }
});

server.listen(PORT, () => console.log(`API server running at http://localhost:${PORT}`));
