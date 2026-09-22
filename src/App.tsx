import { useEffect, useState, type FormEvent } from 'react';
import './styles.css';

type Item = { id: string; createdAt: string; [key: string]: string };
type Resource = { key: string; label: string; fields: string[] };
type PublicReport = {
  id: string;
  code: string;
  location: string;
  description: string;
  contact: string;
  status: '待审核' | '已采纳' | '已驳回';
  rejectReason?: string;
  duplicateOf?: string;
  linkedReportId?: string;
  createdAt: string;
  reviewedAt?: string;
};
type TrackResult = {
  code: string;
  location: string;
  description: string;
  status: string;
  rejectReason?: string;
  duplicateOf?: string;
  message?: string;
  createdAt: string;
  reviewedAt?: string;
};

const config = { "name": "城市公共树木养护协作系统", "description": "用于维护城市公共树木档案、巡检任务和居民异常反馈的基础协作系统。", "flow": "建立树木档案 → 安排巡检 → 记录异常 → 派发养护 → 完成复核", "resources": [{ "key": "trees", "label": "树木档案", "fields": ["species", "location", "health", "lastInspection"] }, { "key": "reports", "label": "异常反馈", "fields": ["tree", "reporter", "issue", "source", "status"] }, { "key": "inspections", "label": "巡检任务", "fields": ["tree", "inspector", "date", "status"] }], "states": ["待派单", "待执行", "处理中", "已完成"], "labels": { "name": "名称", "title": "标题", "category": "分类", "location": "位置", "status": "状态", "equipment": "设备", "member": "成员", "date": "日期", "slot": "时段", "issue": "问题", "assignee": "负责人", "species": "树种", "health": "健康状况", "lastInspection": "最近巡检", "tree": "树木", "reporter": "反馈人", "inspector": "巡检人", "activity": "活动", "checkpoint": "检查点", "route": "路线", "capacity": "人数上限", "phone": "联系方式", "project": "项目", "author": "作者", "editor": "编辑", "version": "版本", "wordCount": "字数", "owner": "负责人", "dueDate": "截止日期", "venue": "场地", "openingDate": "开幕日期", "collectionNo": "藏品编号", "condition": "保存状况", "serialNo": "序列号", "borrower": "借用人", "gear": "器材", "returnDate": "归还日期", "description": "问题描述", "ageGroup": "年龄段", "duration": "时长", "lesson": "课程", "instructor": "讲师", "type": "类型", "customer": "客户", "product": "产品", "priority": "优先级", "order": "订单", "stepName": "工序名称", "workstation": "工作台", "result": "结果", "source": "来源", "code": "反馈编号", "contact": "联系方式", "rejectReason": "驳回原因", "createdAt": "提交时间" } } as { name: string; description: string; flow: string; resources: Resource[]; states: string[]; labels: Record<string, string> };

const reviewStates = ['待审核', '已采纳', '已驳回'];
const reviewModule: Resource = { key: 'publicReports', label: '居民上报审核', fields: [] };

async function api(path: string, options?: RequestInit) {
  const res = await fetch(`/api${path}`, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}
function fmt(iso?: string) {
  return iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '-';
}
function StatusBadge({ status }: { status: string }) {
  const cls = status === '待审核' ? 'pending' : status === '已采纳' ? 'adopted' : status === '已驳回' ? 'rejected' : '';
  return <span className={`status ${cls}`}>{status}</span>;
}

export default function App() {
  const [view, setView] = useState<'admin' | 'public'>('admin');
  return (
    <div className="app">
      <header>
        <div>
          <span className="eyebrow">NODE.JS · TYPESCRIPT · VITE · REACT</span>
          <h1>{config.name}</h1>
          <p>{config.description}</p>
        </div>
        <div className="header-side">
          <span className="badge">基础流程演示</span>
          <button className="ghost" onClick={() => setView(view === 'admin' ? 'public' : 'admin')}>
            {view === 'admin' ? '居民上报入口 →' : '← 返回管理端'}
          </button>
        </div>
      </header>
      {view === 'public' ? <PublicPortal /> : <Admin />}
    </div>
  );
}

function Admin() {
  const modules = [...config.resources.slice(0, 2), reviewModule, ...config.resources.slice(2)];
  const [active, setActive] = useState(config.resources[0].key);
  const [rows, setRows] = useState<Record<string, Item[]>>({});
  const [form, setForm] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const current = modules.find((x) => x.key === active)!;

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
  useEffect(() => {
    load();
  }, []);

  function label(field: string) {
    return config.labels[field] || field;
  }
  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      const payload: Record<string, string> = { ...form, status: form.status || config.states[0] };
      if (active === 'reports' && !payload.source) payload.source = '内部登记';
      await api(`/${active}`, { method: 'POST', body: JSON.stringify(payload) });
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

  return (
    <div className="layout">
      <aside>
        <h2>业务模块</h2>
        {modules.map((r) => (
          <button className={r.key === active ? 'nav active' : 'nav'} onClick={() => { setActive(r.key); setForm({}); }} key={r.key}>
            {r.label}
          </button>
        ))}
        <div className="flow">
          <b>推荐流程</b>
          <p>{config.flow}</p>
        </div>
      </aside>
      <main>
        {active === reviewModule.key ? (
          <PublicReportsAdmin internalReports={rows.reports || []} notify={setNotice} onChanged={load} />
        ) : (
          <>
            <div className="heading">
              <div>
                <span className="eyebrow">CURRENT MODULE</span>
                <h2>{current.label}</h2>
              </div>
              <span className="muted">{(rows[active] || []).length} 条记录</span>
            </div>
            {notice && <div className="notice">{notice}</div>}
            <section className="panel">
              <h3>新增{current.label}</h3>
              <form onSubmit={create} className="form">
                {current.fields.map((field) => (
                  <label key={field}>
                    {label(field)}
                    <input
                      required={field !== 'status' && field !== 'source'}
                      value={form[field] || ''}
                      onChange={(e) => setForm({ ...form, [field]: e.target.value })}
                      placeholder={`请输入${label(field)}`}
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
                      <tr>
                        {current.fields.map((f) => <th key={f}>{label(f)}</th>)}
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(rows[active] || []).map((item) => (
                        <tr key={item.id}>
                          {current.fields.map((f) => <td key={f}>{item[f] || '-'}</td>)}
                          <td>
                            <button className="action" disabled={!config.states.includes(item.status) || item.status === config.states.at(-1)} onClick={() => transition(item)}>
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
        )}
      </main>
    </div>
  );
}

function PublicReportsAdmin({ internalReports, notify, onChanged }: { internalReports: Item[]; notify: (msg: string) => void; onChanged: () => Promise<void> }) {
  const [items, setItems] = useState<PublicReport[]>([]);
  const [filter, setFilter] = useState('待审核');
  const [loading, setLoading] = useState(true);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  async function load() {
    setLoading(true);
    try {
      setItems(await api('/public-reports'));
    } catch (e) {
      notify(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  const countOf = (s: string) => (s === '全部' ? items.length : items.filter((i) => i.status === s).length);
  const shown = items.filter((i) => filter === '全部' || i.status === filter).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const linkedOf = (item: PublicReport) => internalReports.find((r) => r.id === item.linkedReportId);

  async function review(item: PublicReport, action: 'accept' | 'reject') {
    try {
      await api(`/public-reports/${item.id}/review`, { method: 'POST', body: JSON.stringify(action === 'reject' ? { action, reason } : { action }) });
      notify(action === 'accept' ? `已采纳 ${item.code}，并转入「异常反馈」列表（待派单）` : `已驳回 ${item.code}`);
      setRejectingId(null);
      setReason('');
      await load();
      await onChanged(); // 联动刷新内部「异常反馈」列表
    } catch (e) {
      notify(e instanceof Error ? e.message : '操作失败');
    }
  }

  return (
    <>
      <div className="heading">
        <div>
          <span className="eyebrow">CURRENT MODULE</span>
          <h2>居民上报审核</h2>
        </div>
        <span className="muted">{items.length} 条居民反馈</span>
      </div>
      <section className="panel">
        <div className="tabs">
          {['待审核', '已采纳', '已驳回', '全部'].map((s) => (
            <button key={s} className={filter === s ? 'tab active' : 'tab'} onClick={() => setFilter(s)}>
              {s}（{countOf(s)}）
            </button>
          ))}
          <button className="ghost refresh" onClick={load}>刷新</button>
        </div>
        {loading ? (
          <p className="muted">正在加载...</p>
        ) : shown.length === 0 ? (
          <p className="muted">当前状态下暂无居民反馈。</p>
        ) : (
          <div className="table">
            <table>
              <thead>
                <tr>
                  <th>反馈编号</th>
                  <th>树木位置</th>
                  <th>问题描述</th>
                  <th>联系方式</th>
                  <th>提交时间</th>
                  <th>状态</th>
                  <th>驳回原因</th>
                  <th>内部联动</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((item) => (
                  <>
                    <tr key={item.id}>
                      <td>
                        <span className="mono">{item.code}</span>
                        {item.duplicateOf && <span className="dup">疑似重复 → {item.duplicateOf}</span>}
                      </td>
                      <td>{item.location}</td>
                      <td className="desc" title={item.description}>{item.description}</td>
                      <td>{item.contact || '匿名'}</td>
                      <td>{fmt(item.createdAt)}</td>
                      <td><StatusBadge status={item.status} /></td>
                      <td className="desc">{item.rejectReason || '-'}</td>
                      <td>
                        {item.status === '已采纳' ? (
                          <span className="link-status">异常反馈 · {linkedOf(item)?.status || '待派单'}</span>
                        ) : (
                          '-'
                        )}
                      </td>
                      <td>
                        {item.status === '待审核' ? (
                          <span className="ops">
                            <button className="action" onClick={() => review(item, 'accept')}>采纳</button>
                            <button className="action danger" onClick={() => { setRejectingId(item.id); setReason(''); }}>驳回</button>
                          </span>
                        ) : (
                          <span className="muted">已处理</span>
                        )}
                      </td>
                    </tr>
                    {rejectingId === item.id && (
                      <tr key={`${item.id}-reject`} className="reject-row">
                        <td colSpan={9}>
                          <div className="reject-box">
                            <textarea
                              autoFocus
                              placeholder="请填写驳回原因（必填，将展示给提交居民）"
                              value={reason}
                              onChange={(e) => setReason(e.target.value)}
                            />
                            <button className="primary" disabled={!reason.trim()} onClick={() => review(item, 'reject')}>确认驳回</button>
                            <button className="ghost" onClick={() => setRejectingId(null)}>取消</button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function PublicPortal() {
  const [form, setForm] = useState({ location: '', description: '', contact: '' });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<TrackResult | null>(null);
  const [trackCode, setTrackCode] = useState('');
  const [tracked, setTracked] = useState<TrackResult | null>(null);
  const [trackError, setTrackError] = useState('');

  const statusHints: Record<string, string> = {
    待审核: '已收到您的反馈，工作人员将尽快审核。',
    已采纳: '反馈已采纳，已转入养护处理流程。',
    已驳回: '反馈未通过审核，驳回原因如下。',
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setResult(null);
    setSubmitting(true);
    try {
      const res = await api('/public/reports', { method: 'POST', body: JSON.stringify(form) });
      setResult(res);
      setTrackCode(res.code);
      setForm({ location: '', description: '', contact: '' });
    } catch (err) {
      setError(err instanceof Error ? err.message : '提交失败');
    } finally {
      setSubmitting(false);
    }
  }
  async function track(e: FormEvent) {
    e.preventDefault();
    setTrackError('');
    setTracked(null);
    try {
      setTracked(await api(`/public/reports/${encodeURIComponent(trackCode.trim())}`));
    } catch (err) {
      setTrackError(err instanceof Error ? err.message : '查询失败');
    }
  }

  return (
    <div className="public-wrap">
      <section className="panel">
        <h3>公共树木异常上报</h3>
        <p className="muted">发现公共树木枯黄、断枝、病虫害等问题，请填写下方表单。联系方式选填，留空即匿名提交。</p>
        {error && <div className="error">{error}</div>}
        {result && (
          <div className="code-box">
            <div>提交成功，您的反馈编号（请妥善保存用于查询进度）：</div>
            <div className="code">{result.code}</div>
            {result.duplicateOf && <div className="hint">🔀 {result.message}</div>}
          </div>
        )}
        <form onSubmit={submit} className="form public-form">
          <label>
            树木位置 *
            <input required value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="例如：青松路18号人行道旁" />
          </label>
          <label>
            联系方式（选填）
            <input value={form.contact} onChange={(e) => setForm({ ...form, contact: e.target.value })} placeholder="手机号 / 座机 / 邮箱，留空为匿名" />
          </label>
          <label className="full">
            问题描述 *
            <textarea required minLength={5} maxLength={500} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="请描述树木的异常情况，如枝条枯黄、树干开裂、倾斜倒伏风险等" />
          </label>
          <button className="primary" disabled={submitting}>{submitting ? '提交中...' : '提交上报'}</button>
        </form>
      </section>
      <section className="panel">
        <h3>处理进度查询</h3>
        <p className="muted">输入提交时获得的反馈编号，查询审核与处理进度。</p>
        <form onSubmit={track} className="track-form">
          <input required value={trackCode} onChange={(e) => setTrackCode(e.target.value)} placeholder="例如：FB-20260922-AB12" />
          <button className="primary">查询</button>
        </form>
        {trackError && <div className="error">{trackError}</div>}
        {tracked && (
          <div className="track-card">
            <div className="track-head">
              <span className="mono">{tracked.code}</span>
              <StatusBadge status={tracked.status} />
            </div>
            <p><b>树木位置：</b>{tracked.location}</p>
            <p><b>问题描述：</b>{tracked.description}</p>
            <p><b>提交时间：</b>{fmt(tracked.createdAt)}</p>
            {tracked.reviewedAt && <p><b>审核时间：</b>{fmt(tracked.reviewedAt)}</p>}
            <p className="muted">{statusHints[tracked.status]}</p>
            {tracked.status === '已驳回' && tracked.rejectReason && <div className="error">驳回原因：{tracked.rejectReason}</div>}
          </div>
        )}
      </section>
    </div>
  );
}
