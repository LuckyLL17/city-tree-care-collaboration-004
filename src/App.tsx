import { useEffect, useState, type FormEvent } from 'react';
import './styles.css';

type Item = { id: string; createdAt: string; [key: string]: string };
type Resource = { key: string; label: string; fields: string[] };

const config = {
  name: '城市公共树木养护协作系统',
  description: '用于维护城市公共树木档案、巡检任务和居民异常反馈的基础协作系统。',
  flow: '建立树木档案 → 安排巡检 → 记录异常 → 派发养护 → 完成复核',
  resources: [
    { key: 'trees', label: '树木档案', fields: ['species', 'location', 'health', 'lastInspection'] },
    { key: 'reports', label: '异常反馈', fields: ['tree', 'reporter', 'issue', 'status', 'source', 'publicCode'] },
    { key: 'inspections', label: '巡检任务', fields: ['tree', 'inspector', 'date', 'status'] },
  ],
  states: ['待派单', '待执行', '处理中', '已完成'],
  labels: {
    name: '名称', title: '标题', category: '分类', location: '位置', status: '状态', equipment: '设备', member: '成员',
    date: '日期', slot: '时段', issue: '问题', assignee: '负责人', species: '树种', health: '健康状况',
    lastInspection: '最近巡检', tree: '树木', reporter: '反馈人', inspector: '巡检人', activity: '活动',
    checkpoint: '检查点', route: '路线', capacity: '人数上限', phone: '联系方式', project: '项目', author: '作者',
    editor: '编辑', version: '版本', wordCount: '字数', owner: '负责人', dueDate: '截止日期', venue: '场地',
    openingDate: '开幕日期', collectionNo: '藏品编号', condition: '保存状况', serialNo: '序列号', borrower: '借用人',
    gear: '器材', returnDate: '归还日期', description: '描述', ageGroup: '年龄段', duration: '时长', lesson: '课程',
    instructor: '讲师', type: '类型', customer: '客户', product: '产品', priority: '优先级', order: '订单',
    stepName: '工序名称', workstation: '工作台', result: '结果',
    source: '来源', publicCode: '反馈编号', contact: '联系方式', code: '反馈编号', rejectReason: '驳回原因',
  },
} as { name: string; description: string; flow: string; resources: Resource[]; states: string[]; labels: Record<string, string> };

const REVIEW_MODULE = 'publicReports';
const reviewStatuses = ['待审核', '已采纳', '已驳回'] as const;
type ReviewStatus = (typeof reviewStatuses)[number];

interface PublicReport {
  id: string;
  code: string;
  location: string;
  description: string;
  contact: string;
  status: ReviewStatus;
  rejectReason?: string;
  reportId?: string;
  createdAt: string;
  reviewedAt?: string;
}

// 内部模块新增表单中允许留空的字段
const optionalFields = new Set(['status', 'source', 'publicCode']);

async function api(path: string, options?: RequestInit) {
  const res = await fetch(`/api${path}`, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `请求失败（${res.status}）`);
  return data;
}

function fmtTime(iso?: string) {
  return iso ? iso.slice(0, 16).replace('T', ' ') : '-';
}

function StatusChip({ status }: { status: string }) {
  const cls = status === '待审核' ? 'pending' : status === '已采纳' ? 'adopted' : status === '已驳回' ? 'rejected' : 'neutral';
  return <span className={`chip ${cls}`}>{status}</span>;
}

export default function App() {
  const [view, setView] = useState<'admin' | 'public'>('admin');
  const [active, setActive] = useState(config.resources[0].key);
  const [rows, setRows] = useState<Record<string, Item[]>>({});
  const [publicRows, setPublicRows] = useState<PublicReport[]>([]);
  const [form, setForm] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);

  const isReview = active === REVIEW_MODULE;
  const current = config.resources.find((x) => x.key === active);
  const pendingCount = publicRows.filter((r) => r.status === '待审核').length;

  async function load() {
    setLoading(true);
    try {
      const entries = await Promise.all(config.resources.map(async (r) => [r.key, await api(`/${r.key}`)] as const));
      setRows(Object.fromEntries(entries));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }
  async function loadPublic() {
    try {
      setPublicRows(await api('/public-reports'));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : '加载失败');
    }
  }
  useEffect(() => {
    load();
    loadPublic();
  }, []);

  function label(field: string) {
    return config.labels[field] || field;
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      await api(`/${active}`, { method: 'POST', body: JSON.stringify({ ...form, status: form.status || config.states[0] }) });
      setForm({});
      setNotice('记录已创建');
      await load();
    } catch (e2) {
      setNotice(e2 instanceof Error ? e2.message : '创建失败');
    }
  }

  async function transition(item: Item) {
    const i = config.states.indexOf(item.status);
    const next = config.states[Math.min(i + 1, config.states.length - 1)];
    if (!next || next === item.status) return;
    try {
      await api(`/${active}/${item.id}/transition`, { method: 'POST', body: JSON.stringify({ status: next }) });
      setNotice(`状态已更新为：${next}`);
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : '状态更新失败');
    }
  }

  async function review(id: string, action: 'adopt' | 'reject', reason: string): Promise<boolean> {
    try {
      await api(`/public-reports/${id}/review`, {
        method: 'POST',
        body: JSON.stringify(action === 'adopt' ? { action } : { action, reason }),
      });
      setNotice(
        action === 'adopt'
          ? '已采纳该上报，并同步生成内部异常反馈（待派单），可在「异常反馈」模块继续跟进'
          : '已驳回该上报，驳回原因已记录',
      );
      await Promise.all([load(), loadPublic()]);
      return true;
    } catch (e) {
      setNotice(e instanceof Error ? e.message : '审核操作失败');
      return false;
    }
  }

  return (
    <div className="app">
      <header>
        <div>
          <span className="eyebrow">NODE.JS · TYPESCRIPT · VITE · REACT</span>
          <h1>{config.name}</h1>
          <p>{config.description}</p>
        </div>
        <div className="header-side">
          <div className="view-switch">
            <button className={view === 'admin' ? 'on' : ''} onClick={() => setView('admin')}>管理端</button>
            <button className={view === 'public' ? 'on' : ''} onClick={() => setView('public')}>居民上报入口</button>
          </div>
          <span className="badge">基础流程演示</span>
        </div>
      </header>

      {view === 'public' ? (
        <PublicPortal />
      ) : (
        <div className="layout">
          <aside>
            <h2>业务模块</h2>
            {config.resources.map((r) => (
              <button className={r.key === active ? 'nav active' : 'nav'} onClick={() => { setActive(r.key); setForm({}); }} key={r.key}>
                {r.label}
              </button>
            ))}
            <h2 className="aside-sub">公开入口</h2>
            <button className={isReview ? 'nav active' : 'nav'} onClick={() => { setActive(REVIEW_MODULE); setForm({}); }}>
              居民上报审核
              {pendingCount > 0 && <span className="nav-badge">{pendingCount}</span>}
            </button>
            <div className="flow"><b>推荐流程</b><p>{config.flow}</p></div>
          </aside>
          <main>
            {notice && <div className="notice">{notice}</div>}
            {isReview ? (
              <ReviewModule
                rows={publicRows}
                onRefresh={loadPublic}
                onReview={review}
                onOpenReports={() => setActive('reports')}
              />
            ) : (
              current && (
                <>
                  <div className="heading">
                    <div><span className="eyebrow">CURRENT MODULE</span><h2>{current.label}</h2></div>
                    <span className="muted">{(rows[active] || []).length} 条记录</span>
                  </div>
                  <section className="panel">
                    <h3>新增{current.label}</h3>
                    <form onSubmit={create} className="form">
                      {current.fields.map((field) => (
                        <label key={field}>
                          {label(field)}
                          <input
                            required={!optionalFields.has(field)}
                            value={form[field] || ''}
                            onChange={(e) => setForm({ ...form, [field]: e.target.value })}
                            placeholder={`请输入${label(field)}${optionalFields.has(field) && field !== 'status' ? '（可选）' : ''}`}
                          />
                        </label>
                      ))}
                      <button className="primary">保存记录</button>
                    </form>
                  </section>
                  <section className="panel">
                    <div className="panel-title">
                      <h3>{current.label}列表</h3>
                      <button className="ghost" onClick={load}>刷新</button>
                    </div>
                    {loading ? (
                      <p className="muted">正在加载...</p>
                    ) : (
                      <div className="table">
                        <table>
                          <thead>
                            <tr>{current.fields.map((f) => <th key={f}>{label(f)}</th>)}<th>操作</th></tr>
                          </thead>
                          <tbody>
                            {(rows[active] || []).map((item) => (
                              <tr key={item.id}>
                                {current.fields.map((f) => <td key={f}>{item[f] || '-'}</td>)}
                                <td>
                                  <button
                                    className="action"
                                    disabled={!config.states.includes(item.status) || item.status === config.states.at(-1)}
                                    onClick={() => transition(item)}
                                  >
                                    推进状态
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </section>
                </>
              )
            )}
          </main>
        </div>
      )}
    </div>
  );
}

/* ---------------- 管理端：居民上报审核 ---------------- */

function ReviewModule({
  rows,
  onRefresh,
  onReview,
  onOpenReports,
}: {
  rows: PublicReport[];
  onRefresh: () => void;
  onReview: (id: string, action: 'adopt' | 'reject', reason: string) => Promise<boolean>;
  onOpenReports: () => void;
}) {
  const [filter, setFilter] = useState<'全部' | ReviewStatus>('待审核');
  const [rejectingId, setRejectingId] = useState('');
  const [reason, setReason] = useState('');

  const filtered = filter === '全部' ? rows : rows.filter((r) => r.status === filter);
  const countOf = (s: '全部' | ReviewStatus) => (s === '全部' ? rows.length : rows.filter((r) => r.status === s).length);

  async function confirmReject(id: string) {
    if (await onReview(id, 'reject', reason.trim())) {
      setRejectingId('');
      setReason('');
    }
  }

  return (
    <>
      <div className="heading">
        <div><span className="eyebrow">PUBLIC REPORTS</span><h2>居民上报审核</h2></div>
        <span className="muted">{rows.length} 条上报</span>
      </div>
      <section className="panel">
        <div className="panel-title">
          <div className="filter-tabs">
            {(['待审核', '已采纳', '已驳回', '全部'] as const).map((s) => (
              <button key={s} className={filter === s ? 'on' : ''} onClick={() => setFilter(s)}>
                {s}（{countOf(s)}）
              </button>
            ))}
          </div>
          <button className="ghost" onClick={onRefresh}>刷新</button>
        </div>
        {filtered.length === 0 ? (
          <p className="muted">暂无{filter === '全部' ? '' : `「${filter}」`}居民上报记录</p>
        ) : (
          <div className="table">
            <table>
              <thead>
                <tr>
                  <th>反馈编号</th><th>树木位置</th><th>问题描述</th><th>联系方式</th>
                  <th>提交时间</th><th>状态</th><th>驳回原因</th><th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.code}</td>
                    <td>{r.location}</td>
                    <td className="desc-cell">{r.description}</td>
                    <td>{r.contact || '匿名'}</td>
                    <td>{fmtTime(r.createdAt)}</td>
                    <td><StatusChip status={r.status} /></td>
                    <td>{r.rejectReason || '-'}</td>
                    <td>
                      {r.status === '待审核' ? (
                        rejectingId === r.id ? (
                          <span className="reject-inline">
                            <input
                              autoFocus
                              value={reason}
                              onChange={(e) => setReason(e.target.value)}
                              placeholder="请输入驳回原因"
                              maxLength={200}
                            />
                            <button className="action" disabled={reason.trim().length < 2} onClick={() => confirmReject(r.id)}>确认</button>
                            <button className="action" onClick={() => { setRejectingId(''); setReason(''); }}>取消</button>
                          </span>
                        ) : (
                          <span className="op-group">
                            <button className="action" onClick={() => onReview(r.id, 'adopt', '')}>采纳</button>
                            <button className="action danger" onClick={() => { setRejectingId(r.id); setReason(''); }}>驳回</button>
                          </span>
                        )
                      ) : r.status === '已采纳' ? (
                        <button className="action" onClick={onOpenReports}>查看异常反馈</button>
                      ) : (
                        <span className="muted">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

/* ---------------- 居民侧：公开上报与进度查询 ---------------- */

type SubmitResult =
  | { kind: 'created' | 'merged'; code: string; message: string }
  | { kind: 'error'; message: string };

function PublicPortal() {
  const [form, setForm] = useState({ location: '', description: '', contact: '' });
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [trackCode, setTrackCode] = useState('');
  const [tracking, setTracking] = useState(false);
  const [trackData, setTrackData] = useState<PublicReport | null>(null);
  const [trackError, setTrackError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setResult(null);
    try {
      const res = await api('/public/reports', { method: 'POST', body: JSON.stringify(form) });
      if (res.merged) {
        setResult({ kind: 'merged', code: res.code, message: res.message });
      } else {
        setResult({ kind: 'created', code: res.code, message: res.message || '提交成功' });
        setForm({ location: '', description: '', contact: '' });
      }
    } catch (err) {
      setResult({ kind: 'error', message: err instanceof Error ? err.message : '提交失败，请稍后再试' });
    } finally {
      setSubmitting(false);
    }
  }

  async function track(e: FormEvent) {
    e.preventDefault();
    if (!trackCode.trim()) return;
    setTracking(true);
    setTrackError('');
    setTrackData(null);
    try {
      setTrackData(await api(`/public/reports/${encodeURIComponent(trackCode.trim())}`));
    } catch (err) {
      setTrackError(err instanceof Error ? err.message : '查询失败');
    } finally {
      setTracking(false);
    }
  }

  return (
    <main className="public-main">
      <div className="heading">
        <div><span className="eyebrow">PUBLIC PORTAL</span><h2>居民异常上报</h2></div>
        <span className="muted">无需登录 · 支持匿名 · 内部处理数据不对外公开</span>
      </div>
      <div className="public-grid">
        <section className="panel">
          <h3>填写上报信息</h3>
          <form onSubmit={submit} className="public-form">
            <label>
              树木位置（必填）
              <input
                required
                minLength={2}
                maxLength={120}
                value={form.location}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
                placeholder="例如：青松路18号东侧人行道"
              />
            </label>
            <label>
              问题描述（必填）
              <textarea
                required
                minLength={5}
                maxLength={500}
                rows={4}
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="请描述树木的异常情况，例如枯枝、倾斜、病虫害等"
              />
            </label>
            <label>
              联系方式（选填，手机号 / 座机 / 邮箱）
              <input
                maxLength={50}
                value={form.contact}
                onChange={(e) => setForm({ ...form, contact: e.target.value })}
                placeholder="便于工作人员回访，可留空匿名提交"
              />
            </label>
            <button className="primary" disabled={submitting}>{submitting ? '提交中...' : '提交上报'}</button>
          </form>
          {result && (
            <div className={`result ${result.kind}`}>
              <p>{result.message}</p>
              {result.kind !== 'error' && (
                <div className="code-box">
                  <span>反馈编号</span>
                  <b>{result.code}</b>
                </div>
              )}
              {result.kind === 'created' && <p className="muted">请妥善保存该编号，可在右侧「进度查询」中跟踪处理状态。</p>}
            </div>
          )}
        </section>
        <section className="panel">
          <h3>进度查询</h3>
          <form onSubmit={track} className="track-form">
            <input
              value={trackCode}
              onChange={(e) => setTrackCode(e.target.value)}
              placeholder="请输入反馈编号，如 FB-20260922-AB12"
            />
            <button className="primary" disabled={tracking}>{tracking ? '查询中...' : '查询'}</button>
          </form>
          {trackError && <div className="result error"><p>{trackError}</p></div>}
          {trackData && (
            <div className="track-card">
              <div className="track-head">
                <span className="mono">{trackData.code}</span>
                <StatusChip status={trackData.status} />
              </div>
              <dl>
                <dt>树木位置</dt><dd>{trackData.location}</dd>
                <dt>问题描述</dt><dd>{trackData.description}</dd>
                <dt>提交时间</dt><dd>{fmtTime(trackData.createdAt)}</dd>
                {trackData.reviewedAt && <><dt>审核时间</dt><dd>{fmtTime(trackData.reviewedAt)}</dd></>}
                {trackData.status === '已驳回' && trackData.rejectReason && <><dt>驳回原因</dt><dd>{trackData.rejectReason}</dd></>}
              </dl>
              <p className="muted">
                {trackData.status === '待审核' && '工作人员正在核实，请耐心等待。'}
                {trackData.status === '已采纳' && '该问题已纳入养护处理流程，感谢你的反馈。'}
                {trackData.status === '已驳回' && '该上报未被采纳，如有疑问可补充信息后重新提交。'}
              </p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
