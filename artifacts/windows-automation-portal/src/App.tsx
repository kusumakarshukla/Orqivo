import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import {
  Activity, AlertCircle, AlertTriangle, ArrowDownToLine, ArrowLeft, ArrowRight, Bell, Check,
  CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Clock3, Command, Cpu,
  Download, ExternalLink, FileCheck2, Filter, Gauge, HardDrive, LayoutDashboard, ListChecks,
  LoaderCircle, LogOut, Menu, Monitor, MoreHorizontal, Play, Plus, RefreshCw, Search, Server,
  Settings2, Shield, ShieldCheck, SlidersHorizontal, Terminal, Users, X, Zap
} from 'lucide-react';
import {
  cancelJob, createAutomation, createJob, createServer, downloadJobLog, exportJobs,
  logout, retryJob, setAutomationStatus, setServerStatus, testServerConnection, updateAutomation,
  updateServer, useGetCurrentUser, useGetDashboardActivity, useGetDashboardSummary, useGetJob, useHealthCheck, useLogin,
  useGetJobEvents, useListAuditLogs, useListAutomations, useListJobs, useListServers,
  getGetCurrentUserQueryKey, getGetDashboardActivityQueryKey, getGetDashboardSummaryQueryKey,
  getGetJobEventsQueryKey, getGetJobQueryKey, getListAuditLogsQueryKey, getListAutomationsQueryKey,
  getListJobsQueryKey, getListServersQueryKey
} from '@workspace/api-client-react';
import type { Automation, AutomationInput, Job, JobInput, Server as ServerRecord, ServerInput, User } from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });
const seeded = [
  { label: 'Administrator', email: 'admin@portal.local', role: 'admin' },
  { label: 'Operator', email: 'operator@portal.local', role: 'operator' },
  { label: 'Viewer', email: 'viewer@portal.local', role: 'viewer' },
];
const rolePower = { viewer: 0, operator: 1, admin: 2 };
const roleCan = (role: User['role'] | undefined, required: User['role']) =>
  !!role && (rolePower[role] ?? -1) >= (rolePower[required] ?? 99);
const dateText = (value?: string | null) => value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const initials = (name = 'Operator') => name.split(/\s+/).slice(0, 2).map(x => x[0]).join('').toUpperCase();
const errorText = (err: unknown) => err instanceof Error ? err.message : 'The request could not be completed.';

function ToastHost() {
  const [toast, setToast] = useState('');
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      setToast(detail);
      window.setTimeout(() => setToast(''), 3500);
    };
    window.addEventListener('portal-toast', listener);
    return () => window.removeEventListener('portal-toast', listener);
  }, []);
  return toast ? <div role="status" data-testid="status-toast" className="fixed bottom-5 right-5 z-50 flex items-center gap-3 rounded-xl bg-[#20334d] px-4 py-3 text-sm font-semibold text-white shadow-xl fade-in"><CheckCircle2 size={18} className="text-emerald-300" />{toast}<button aria-label="Dismiss notification" onClick={() => setToast('')} className="ml-2 rounded p-1 hover:bg-white/10"><X size={15}/></button></div> : null;
}
function notify(message: string) { window.dispatchEvent(new CustomEvent('portal-toast', { detail: message })); }

function Button({ children, onClick, kind = 'primary', disabled, type = 'button', testId, className = '' }: {
  children: ReactNode; onClick?: () => void; kind?: 'primary' | 'secondary' | 'danger' | 'quiet'; disabled?: boolean;
  type?: 'button' | 'submit'; testId: string; className?: string;
}) {
  const styles = { primary: 'bg-[#1769c2] text-white hover:bg-[#1059a8] border-transparent', secondary: 'bg-white text-[#263b55] hover:bg-slate-50 border-slate-200', danger: 'bg-red-50 text-red-700 hover:bg-red-100 border-red-200', quiet: 'bg-transparent text-slate-600 hover:bg-slate-100 border-transparent' };
  return <button type={type} onClick={onClick} disabled={disabled} data-testid={testId} className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border px-3.5 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${styles[kind]} ${className}`}>{children}</button>;
}
function Card({ children, className = '' }: { children: ReactNode; className?: string }) { return <section className={`portal-card ${className}`}>{children}</section>; }
function SectionTitle({ eyebrow, title, detail, action }: { eyebrow?: string; title: string; detail?: string; action?: ReactNode }) {
  return <div className="mb-6 flex flex-wrap items-end justify-between gap-4"><div>{eyebrow && <p className="mb-1 text-[11px] font-bold uppercase tracking-[.16em] text-[#52718f]">{eyebrow}</p>}<h1 className="text-[26px] font-bold tracking-[-.035em] text-[#1c2d43]">{title}</h1>{detail && <p className="mt-1.5 text-sm text-slate-500">{detail}</p>}</div>{action}</div>;
}
function Skeleton({ rows = 3 }: { rows?: number }) { return <div aria-label="Loading" className="space-y-3" data-testid="loading-skeleton">{Array.from({ length: rows }, (_, i) => <div key={i} className="h-14 animate-pulse rounded-lg bg-slate-100" />)}</div>; }
function Empty({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <div className="flex min-h-48 flex-col items-center justify-center px-6 text-center" data-testid="empty-state"><span className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-[#edf4fb] text-[#3976b8]"><FileCheck2 size={21}/></span><h3 className="font-semibold text-[#273b53]">{title}</h3><p className="mt-1 max-w-sm text-sm text-slate-500">{detail}</p>{action && <div className="mt-4">{action}</div>}</div>;
}
function ErrorPanel({ error, retry }: { error: unknown; retry?: () => void }) { return <div role="alert" data-testid="connection-error" className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"><AlertCircle size={18} className="mt-0.5 shrink-0 text-amber-700"/><div className="flex-1"><strong className="block">Could not reach the portal service</strong><span className="mt-1 block text-amber-900/80">{errorText(error)}</span></div>{retry && <button data-testid="button-retry-request" className="font-semibold underline" onClick={retry}>Try again</button>}</div>; }
function Badge({ children, tone = 'blue' }: { children: ReactNode; tone?: string }) {
  const styles: Record<string, string> = { blue: 'bg-blue-50 text-blue-700', green: 'bg-emerald-50 text-emerald-700', amber: 'bg-amber-50 text-amber-800', red: 'bg-red-50 text-red-700', slate: 'bg-slate-100 text-slate-600', navy: 'bg-[#e8edf4] text-[#344b67]' };
  return <span className={`inline-flex items-center rounded-md px-2 py-1 text-[11px] font-bold capitalize ${styles[tone] || styles.slate}`}>{children}</span>;
}
function Status({ status }: { status: string }) {
  const tone = ['successful', 'online', 'success', 'connected'].includes(status.toLowerCase()) ? 'green' : ['failed', 'error', 'offline'].includes(status.toLowerCase()) ? 'red' : ['running', 'queued', 'pending', 'validating'].includes(status.toLowerCase()) ? 'blue' : status.toLowerCase() === 'warning' ? 'amber' : 'slate';
  return <Badge tone={tone}>{status.replaceAll('_', ' ')}</Badge>;
}
function Field({ label, children, help }: { label: string; children: ReactNode; help?: string }) { return <label className="block space-y-1.5"><span className="text-sm font-semibold text-[#334960]">{label}</span>{children}{help && <span className="block text-xs text-slate-500">{help}</span>}</label>; }
const inputClass = 'w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-[#24384f] placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100';

function LoginPage({ sessionError }: { sessionError?: unknown }) {
  const [, setLocation] = useLocation();
  const [email, setEmail] = useState(seeded[0].email);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const signIn = useLogin();
  const qc = useQueryClient();
  async function submit(e: FormEvent) {
    e.preventDefault(); setError('');
    try { const user = await signIn.mutateAsync({ data: { email, password } }); qc.setQueryData(getGetCurrentUserQueryKey(), user); setLocation('/dashboard'); }
    catch (err) { setError(errorText(err)); }
  }
  return <main className="grid min-h-[100dvh] bg-[#f3f6fa] lg:grid-cols-[minmax(380px,1fr)_minmax(440px,.92fr)]">
    <div className="relative hidden overflow-hidden bg-[#20334d] p-12 text-white lg:flex lg:flex-col lg:justify-between">
      <div className="absolute -right-24 -top-24 h-[30rem] w-[30rem] rounded-full border border-white/10"/><div className="absolute -right-8 -top-8 h-[20rem] w-[20rem] rounded-full border border-white/10"/>
      <Brand inverse />
      <div className="relative max-w-xl pb-8"><p className="mb-4 text-xs font-bold uppercase tracking-[.2em] text-blue-200">Windows automation control room</p><h1 className="text-5xl font-bold leading-[1.08] tracking-[-.045em]">The right work.<br/>On the right server.<br/><span className="text-blue-200">With a clear record.</span></h1><p className="mt-6 max-w-md text-base leading-7 text-slate-300">A governed workspace for approved PowerShell operations. Every submission is validated, tracked, and safe by default.</p></div>
      <div className="flex gap-6 text-xs text-slate-300"><span className="flex items-center gap-2"><ShieldCheck size={15}/> Role-aware access</span><span className="flex items-center gap-2"><Activity size={15}/> Traceable runs</span></div>
    </div>
    <div className="flex items-center justify-center px-5 py-10 sm:px-10"><div className="w-full max-w-[430px]">
      <div className="mb-8 lg:hidden"><Brand /></div>
      <p className="mb-2 text-xs font-bold uppercase tracking-[.17em] text-[#51708e]">Secure operator access</p><h2 className="text-3xl font-bold tracking-[-.04em] text-[#1c2d43]">Welcome back</h2><p className="mt-2 text-sm text-slate-500">Sign in to continue to your operations workspace.</p>
      {Boolean(sessionError) && <div role="status" data-testid="session-check-message" className="mb-4 rounded-lg border border-blue-100 bg-blue-50 p-3 text-xs leading-5 text-blue-950"><strong className="block">No active session was verified.</strong><span>{errorText(sessionError)} Sign in with a development account to continue.</span></div>}
      <form onSubmit={submit} className="mt-8 space-y-5">
        <Field label="Work email"><input required type="email" autoComplete="username" className={inputClass} value={email} onChange={e => setEmail(e.target.value)} data-testid="input-login-email" placeholder="you@company.com"/></Field>
        <Field label="Password"><input required type="password" autoComplete="current-password" className={inputClass} value={password} onChange={e => setPassword(e.target.value)} data-testid="input-login-password" placeholder="Enter your password"/></Field>
        {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700" data-testid="login-error">{error}</div>}
        <Button type="submit" testId="button-login" disabled={signIn.isPending} className="w-full">{signIn.isPending ? <LoaderCircle className="animate-spin" size={16}/> : <ShieldCheck size={16}/>} {signIn.isPending ? 'Signing in…' : 'Sign in'}</Button>
      </form>
      <div className="mt-7 rounded-xl border border-blue-100 bg-[#edf5fc] p-4">
        <div className="flex items-center gap-2 text-sm font-bold text-[#264d74]"><CircleHelp size={16}/> Development-only seeded accounts</div>
        <p className="mt-1 text-xs leading-5 text-slate-600">Choose a seeded identity to prefill its email. A valid development password is still required. Passwords are intentionally not shown.</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">{seeded.map(account => <button key={account.role} type="button" data-testid={`button-seed-${account.role}`} onClick={() => { setEmail(account.email); setError(''); }} className="rounded-lg border border-blue-100 bg-white px-2.5 py-2 text-left hover:border-blue-300"><span className="block text-xs font-bold text-[#2a4664]">{account.label}</span><span className="mt-0.5 block truncate text-[10px] text-slate-500">{account.email}</span></button>)}</div>
      </div>
      <p className="mt-8 text-center text-xs text-slate-400">Access is monitored and recorded for operational safety.</p>
    </div></div>
  </main>;
}
function Brand({ inverse = false }: { inverse?: boolean }) { return <Link href="/dashboard" data-testid="link-brand" className="inline-flex w-fit items-center gap-3"><span className={`flex h-10 w-10 items-center justify-center rounded-xl ${inverse ? 'bg-blue-500 text-white' : 'bg-[#1769c2] text-white'}`}><Command size={21}/></span><span><span className={`block text-sm font-bold tracking-tight ${inverse ? 'text-white' : 'text-[#24384f]'}`}>Northstar <span className="font-normal opacity-75">Ops</span></span><span className={`block text-[10px] uppercase tracking-[.16em] ${inverse ? 'text-blue-200' : 'text-slate-500'}`}>Automation portal</span></span></Link>; }

const navGroups = [
  { title: 'WORKSPACE', links: [{ href: '/dashboard', text: 'Overview', icon: LayoutDashboard }, { href: '/automations', text: 'Automations', icon: ListChecks }, { href: '/run', text: 'Submit a run', icon: Play }, { href: '/jobs', text: 'Job history', icon: Activity }] },
  { title: 'INFRASTRUCTURE', links: [{ href: '/servers', text: 'Servers', icon: Server }] },
];
function PortalShell({ user, children }: { user: User; children: ReactNode }) {
  const [location] = useLocation(); const [collapsed, setCollapsed] = useState(false); const [mobileOpen, setMobileOpen] = useState(false);
  const health = useHealthCheck();
  const admin = user.role === 'admin';
  const links = [...navGroups.map(group => ({ ...group, links: group.links.filter(item => item.href !== '/run' || roleCan(user.role, 'operator')) })), ...(admin ? [{ title: 'GOVERNANCE', links: [{ href: '/admin/automations', text: 'Automation admin', icon: Settings2 }, { href: '/audit', text: 'Audit log', icon: Shield }] }] : [])];
  const sidebar = <aside className={`portal-sidebar fixed inset-y-0 left-0 z-40 flex flex-col transition-all duration-200 ${collapsed ? 'w-[76px]' : 'w-[252px]'} ${mobileOpen ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0`}>
    <div className={`flex h-[76px] items-center border-b border-white/10 ${collapsed ? 'justify-center px-2' : 'px-5'}`}><Brand inverse/><button onClick={() => setCollapsed(!collapsed)} aria-label="Collapse navigation" data-testid="button-collapse-sidebar" className="ml-auto hidden rounded-md p-1.5 text-slate-300 hover:bg-white/10 lg:block"><ChevronLeft size={17} className={collapsed ? 'rotate-180' : ''}/></button></div>
    <nav className="flex-1 overflow-y-auto px-3 py-5">{links.map(group => <div key={group.title} className="mb-6"><p className={`mb-2 px-3 text-[9px] font-bold tracking-[.16em] text-slate-400 ${collapsed ? 'sr-only' : ''}`}>{group.title}</p>{group.links.map(item => { const Icon = item.icon; const active = location === item.href || (item.href === '/jobs' && location.startsWith('/jobs/')); return <Link key={item.href} href={item.href} onClick={() => setMobileOpen(false)} title={collapsed ? item.text : undefined} data-testid={`link-nav-${item.href.replaceAll('/', '').replaceAll('-', '')}`} className={`portal-nav-link mb-1 flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold ${active ? 'bg-[#1769c2] text-white shadow-sm' : 'text-slate-300 hover:bg-white/10 hover:text-white'} ${collapsed ? 'justify-center px-2' : ''}`}><Icon size={18}/>{!collapsed && <span>{item.text}</span>}</Link>; })}</div>)}</nav>
    <Link href="/profile" data-testid="link-profile-sidebar" className={`mx-3 mb-4 flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 p-3 hover:bg-white/10 ${collapsed ? 'justify-center px-1' : ''}`}><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#49627e] text-xs font-bold">{initials(user.full_name)}</span>{!collapsed && <span className="min-w-0"><span className="block truncate text-xs font-bold">{user.full_name}</span><span className="block text-[10px] capitalize text-slate-300">{user.role} access</span></span>}</Link>
  </aside>;
  return <div className="portal-shell"><div className="lg:hidden">{mobileOpen && <button aria-label="Close navigation" className="fixed inset-0 z-30 bg-slate-950/40" onClick={() => setMobileOpen(false)}/>}</div>{sidebar}
    <div className={`min-h-[100dvh] transition-[padding] duration-200 ${collapsed ? 'lg:pl-[76px]' : 'lg:pl-[252px]'}`}>
      <header className="sticky top-0 z-20 flex h-[76px] items-center justify-between border-b border-[#e4eaf0] bg-white/95 px-4 backdrop-blur sm:px-7">
        <div className="flex items-center gap-3"><button onClick={() => setMobileOpen(true)} data-testid="button-open-sidebar" aria-label="Open navigation" className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 lg:hidden"><Menu size={19}/></button><div className="hidden h-8 w-px bg-slate-200 sm:block"/><span className="text-xs font-medium text-slate-500">Operations <span className="mx-1 text-slate-300">/</span><span className="font-semibold capitalize text-[#2e445e]">{location.split('/').filter(Boolean).at(-1)?.replaceAll('-', ' ') || 'overview'}</span></span></div>
        <div className="flex items-center gap-2"><div data-testid="status-api-health" className={`hidden items-center gap-2 rounded-lg px-3 py-2 text-[11px] font-bold sm:flex ${health.isError ? 'bg-amber-50 text-amber-800' : 'bg-[#eef7f1] text-emerald-800'}`}><span className={`h-1.5 w-1.5 rounded-full ${health.isError ? 'bg-amber-500' : 'bg-emerald-500'}`}/>{health.isLoading ? 'Checking service' : health.isError ? 'Service unavailable' : 'Portal connected'}</div><Link href="/profile" aria-label="Profile" data-testid="link-profile-top" className="flex h-9 w-9 items-center justify-center rounded-full bg-[#eaf1f8] text-xs font-bold text-[#375675]">{initials(user.full_name)}</Link></div>
      </header><main className="mx-auto w-full max-w-[1480px] px-4 py-7 sm:px-7 lg:px-9">{children}</main>
    </div>
  </div>;
}

function useUser() { return useGetCurrentUser({ query: { queryKey: getGetCurrentUserQueryKey(), retry: false } }); }
function Dashboard({ user }: { user: User }) {
  const summary = useGetDashboardSummary({ query: { queryKey: getGetDashboardSummaryQueryKey() } });
  const activity = useGetDashboardActivity({ limit: 8 }, { query: { queryKey: getGetDashboardActivityQueryKey({ limit: 8 }) } });
  const stats = summary.data;
  return <div className="fade-in"><SectionTitle eyebrow="Operations overview" title={`Good morning, ${user.full_name.split(' ')[0]}`} detail="A clear view of your automation estate and recent activity." action={roleCan(user.role, 'operator') ? <Link href="/run" data-testid="link-start-run" className="inline-flex h-10 items-center gap-2 rounded-lg bg-[#1769c2] px-4 text-sm font-bold text-white hover:bg-[#1059a8]"><Play size={15}/> New run</Link> : undefined}/>
    {summary.isError && <div className="mb-5"><ErrorPanel error={summary.error} retry={() => summary.refetch()}/></div>}
    {stats && <div className="mb-5 flex flex-wrap items-center gap-2"><Badge tone={stats.mock_mode ? 'amber' : 'green'}>{stats.mock_mode ? 'Mock execution mode' : 'Live execution mode'}</Badge><span className="flex items-center gap-1.5 text-xs text-slate-500"><span className={`h-2 w-2 rounded-full ${stats.worker_online ? 'bg-emerald-500' : 'bg-red-500'}`}/>{stats.worker_online ? 'Worker online' : 'Worker offline'}</span></div>}
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {[
        { label: 'Total jobs', value: stats?.total, icon: Activity, color: 'blue' },
        { label: 'Running now', value: stats?.running, icon: LoaderCircle, color: 'amber' },
        { label: 'Successful', value: stats?.successful, icon: CheckCircle2, color: 'green' },
        { label: 'Success rate', value: stats ? `${Number(stats.success_rate).toFixed(1)}%` : undefined, icon: Gauge, color: 'navy' },
      ].map((item, i) => { const Icon = item.icon; return <Card key={item.label} className="p-5"><div className="flex items-start justify-between"><span className="text-sm font-semibold text-slate-500">{item.label}</span><span className={`rounded-lg p-2 ${item.color === 'green' ? 'bg-emerald-50 text-emerald-700' : item.color === 'amber' ? 'bg-amber-50 text-amber-700' : item.color === 'navy' ? 'bg-slate-100 text-slate-700' : 'bg-blue-50 text-blue-700'}`}><Icon size={18}/></span></div><div className="mt-3 text-[30px] font-bold tracking-[-.04em] text-[#20344c]">{summary.isLoading ? <span className="inline-block h-8 w-20 animate-pulse rounded bg-slate-100"/> : item.value ?? '—'}</div><p className="mt-1 text-xs text-slate-400">{i === 3 ? 'Across completed jobs' : 'From recorded automation runs'}</p></Card>; })}
    </div>
    <div className="mt-5 grid gap-5 xl:grid-cols-[1.5fr_.8fr]">
      <Card><div className="flex items-center justify-between border-b border-slate-100 px-5 py-4"><div><h2 className="font-bold text-[#243950]">Recent activity</h2><p className="mt-0.5 text-xs text-slate-500">Latest runs across your environment</p></div><Link href="/jobs" className="text-xs font-bold text-[#1769c2] hover:underline" data-testid="link-view-all-jobs">View all jobs <ArrowRight size={13} className="inline ml-1"/></Link></div>
        {activity.isLoading ? <div className="p-5"><Skeleton rows={5}/></div> : activity.isError ? <div className="p-5"><ErrorPanel error={activity.error} retry={() => activity.refetch()}/></div> : !activity.data?.length ? <Empty title="No activity recorded yet" detail="Submitted automation runs will appear here with a traceable status."/ > : <div className="divide-y divide-slate-100">{activity.data.map(job => <JobRow key={job.id} job={job}/>)}</div>}
      </Card>
      <Card className="p-5"><div className="flex items-start justify-between"><div><h2 className="font-bold text-[#243950]">Execution health</h2><p className="mt-1 text-xs text-slate-500">Current platform signals</p></div><ShieldCheck className="text-[#1769c2]" size={20}/></div>
        <div className="mt-5 space-y-4">{[
          ['Worker service', stats ? (stats.worker_online ? 'Online' : 'Offline') : '—', stats?.worker_online],
          ['Execution mode', stats ? (stats.mock_mode ? 'Mock mode' : 'Live mode') : '—', stats ? !stats.mock_mode : undefined],
          ['Failed jobs', stats ? String(stats.failed) : '—', stats ? stats.failed === 0 : undefined],
        ].map(([label, val, good]) => <div key={String(label)} className="flex items-center justify-between border-b border-slate-100 pb-3 last:border-0"><span className="text-sm text-slate-600">{label}</span><span className={`flex items-center gap-1.5 text-xs font-bold ${good === false ? 'text-amber-700' : good === true ? 'text-emerald-700' : 'text-slate-400'}`}>{good !== undefined && <span className={`h-1.5 w-1.5 rounded-full ${good ? 'bg-emerald-500' : 'bg-amber-500'}`}/>} {val}</span></div>)}</div>
        <div className="mt-3 rounded-lg bg-[#f5f8fb] p-3 text-xs leading-5 text-slate-500"><Shield size={14} className="mr-1 inline text-[#537492]"/> Runs are limited to registered automation keys and approved server targets.</div>
      </Card>
    </div>
  </div>;
}
function JobRow({ job }: { job: Job }) { return <Link href={`/jobs/${job.id}`} data-testid={`link-job-${job.id}`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 hover:bg-slate-50"><div className="flex min-w-0 items-center gap-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#eef4fa] text-[#527596]"><Terminal size={17}/></span><span className="min-w-0"><span className="block truncate text-sm font-semibold text-[#2b415b]">{job.automation_name}</span><span className="mt-0.5 block truncate text-xs text-slate-500">{job.server_name} · {job.requested_by}</span></span></div><span className="flex items-center gap-3"><span className="hidden text-xs text-slate-400 md:block">{dateText(job.submitted_at)}</span><Status status={job.status}/></span></Link>; }

function Automations({ user }: { user: User }) {
  const [search, setSearch] = useState(''); const [risk, setRisk] = useState(''); const [active, setActive] = useState('true');
  const params = useMemo(() => ({ search: search || undefined, risk: risk || undefined, active: active === 'all' ? undefined : active === 'true' }), [search, risk, active]);
  const query = useListAutomations(params, { query: { queryKey: getListAutomationsQueryKey(params) } });
  return <div className="fade-in"><SectionTitle eyebrow="Approved catalogue" title="Automations" detail="Registered workflows available for approved server operations." action={roleCan(user.role, 'operator') ? <Link href="/run" data-testid="link-run-automation" className="inline-flex h-10 items-center gap-2 rounded-lg bg-[#1769c2] px-4 text-sm font-bold text-white"><Play size={15}/> Run automation</Link> : undefined}/>
    <Card className="mb-5 p-4"><div className="grid gap-3 sm:grid-cols-[1fr_180px_180px]"><div className="relative"><Search className="absolute left-3 top-3 text-slate-400" size={16}/><input className={`${inputClass} pl-9`} placeholder="Search automations…" value={search} onChange={e => setSearch(e.target.value)} data-testid="input-automation-search"/></div><select className={inputClass} value={risk} onChange={e => setRisk(e.target.value)} data-testid="select-risk-filter"><option value="">All risk levels</option><option value="low">Low risk</option><option value="medium">Medium risk</option><option value="high">High risk</option></select><select className={inputClass} value={active} onChange={e => setActive(e.target.value)} data-testid="select-automation-status"><option value="true">Active only</option><option value="all">All automations</option><option value="false">Inactive</option></select></div></Card>
    {query.isLoading ? <Skeleton rows={5}/> : query.isError ? <ErrorPanel error={query.error} retry={() => query.refetch()}/> : !query.data?.length ? <Card><Empty title="No matching automations" detail="Try adjusting your filters. Registered automations will appear here."/></Card> :
      <div className="grid gap-4 xl:grid-cols-2">{query.data.map(a => <AutomationCard key={a.id} automation={a} canRun={roleCan(user.role, a.required_role)}/>)}</div>}
  </div>;
}
function AutomationCard({ automation: a, canRun }: { automation: Automation; canRun: boolean }) { return <Card className="overflow-hidden"><div className="flex items-start gap-4 p-5"><span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#edf4fb] text-[#3674b5]"><Cpu size={19}/></span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h2 className="font-bold text-[#263b54]">{a.name}</h2><Badge tone={a.risk_level === 'high' ? 'red' : a.risk_level === 'medium' ? 'amber' : 'green'}>{a.risk_level} risk</Badge>{!a.is_active && <Badge tone="slate">Inactive</Badge>}</div><p className="mt-2 text-sm leading-6 text-slate-500">{a.description}</p><div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-slate-500"><span className="mono text-[10px]">{a.code}</span><span className="flex items-center gap-1"><Clock3 size={13}/>{a.expected_minutes} min</span><span className="flex items-center gap-1"><Monitor size={13}/>{a.target_os}</span><span className="flex items-center gap-1"><Shield size={13}/><span className="capitalize">{a.required_role} minimum</span></span></div><div className="mt-4 flex items-center gap-2">{a.is_active && canRun && <Link href={`/run?automation=${encodeURIComponent(a.id)}`} data-testid={`link-run-${a.id}`} className="inline-flex h-9 items-center gap-2 rounded-lg bg-[#1769c2] px-3 text-xs font-bold text-white hover:bg-[#1059a8]"><Play size={13}/> Start run</Link>}<Badge tone={a.requires_confirmation ? 'amber' : 'navy'}>{a.requires_confirmation ? 'Confirmation required' : 'Standard approval'}</Badge>{a.requires_change_number && <Badge tone="navy">Change number</Badge>}</div></div></div></Card>; }

function RunPage() {
  const [location, setLocation] = useLocation(); const params = new URLSearchParams(location.split('?')[1] || '');
  const [automationId, setAutomationId] = useState(params.get('automation') || '');
  const [serverId, setServerId] = useState(''); const [values, setValues] = useState<Record<string, unknown>>({});
  const [reason, setReason] = useState(''); const [change, setChange] = useState(''); const [confirmed, setConfirmed] = useState(false); const [result, setResult] = useState('');
  const autos = useListAutomations({ active: true }, { query: { queryKey: getListAutomationsQueryKey({ active: true }) } });
  const servers = useListServers({ query: { queryKey: getListServersQueryKey() } });
  const user = useUser(); const qc = useQueryClient();
  const automation = autos.data?.find(a => a.id === automationId);
  const canRun = roleCan(user.data?.role, automation?.required_role || 'operator');
  const submit = useMutation({ mutationFn: (data: JobInput) => createJob(data), onSuccess: job => {
    setResult(job.id); notify('Run submitted and recorded'); qc.invalidateQueries({ queryKey: getListJobsQueryKey() }); qc.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() }); qc.invalidateQueries({ queryKey: getGetDashboardActivityQueryKey({ limit: 8 }) });
  } });
  function updateValue(name: string, value: unknown) { setValues(prev => ({ ...prev, [name]: value })); }
  function handleSubmit(e: FormEvent) {
    e.preventDefault(); if (!automation || !confirmed) return;
    const missing = automation.parameter_schema.find(p => p.required && (values[p.name] === undefined || values[p.name] === ''));
    if (missing) { notify(`Complete required field: ${missing.label}`); return; }
    submit.mutate({ automation_id: automation.id, server_id: serverId, parameters: values, business_reason: reason, confirmed: true, ...(automation.requires_change_number ? { change_number: change } : {}) });
  }
  return <div className="fade-in"><SectionTitle eyebrow="Controlled submission" title="Submit an automation run" detail="Validate the target and inputs before the request enters the execution queue."/>
    {result ? <Card className="p-8"><div className="mx-auto max-w-lg text-center"><span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-700"><CheckCircle2 size={28}/></span><h2 className="mt-4 text-xl font-bold text-[#243950]">Run submitted</h2><p className="mt-2 text-sm text-slate-500">The request is now traceable in job history.</p><p className="mono mt-3 text-xs text-slate-500">Job {result}</p><div className="mt-6 flex justify-center gap-3"><Link href={`/jobs/${result}`} className="inline-flex h-10 items-center gap-2 rounded-lg bg-[#1769c2] px-4 text-sm font-bold text-white" data-testid="link-open-submitted-job">Open job <ArrowRight size={15}/></Link><Button kind="secondary" testId="button-submit-another" onClick={() => { setResult(''); setConfirmed(false); setReason(''); setValues({}); }}>Submit another</Button></div></div></Card> :
    <form onSubmit={handleSubmit} className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_330px]">
      <Card className="space-y-6 p-5 sm:p-7">
        {autos.isError && <ErrorPanel error={autos.error} retry={() => autos.refetch()}/>}
        {servers.isError && <ErrorPanel error={servers.error} retry={() => servers.refetch()}/>}
        <Field label="Approved automation"><select required className={inputClass} value={automationId} onChange={e => { setAutomationId(e.target.value); setValues({}); }} data-testid="select-run-automation"><option value="">Choose a registered automation</option>{autos.data?.map(a => <option key={a.id} value={a.id}>{a.name} · {a.risk_level} risk</option>)}</select></Field>
        {automation && <div className="rounded-lg bg-[#f4f8fc] p-4"><div className="flex items-start justify-between gap-4"><div><h3 className="font-bold text-[#2d4560]">{automation.name}</h3><p className="mt-1 text-sm leading-5 text-slate-500">{automation.description}</p></div><Badge tone={automation.risk_level === 'high' ? 'red' : automation.risk_level === 'medium' ? 'amber' : 'green'}>{automation.risk_level} risk</Badge></div></div>}
        <Field label="Target server"><select required className={inputClass} value={serverId} onChange={e => setServerId(e.target.value)} data-testid="select-run-server"><option value="">Choose an active server</option>{servers.data?.filter(s => s.is_active).map(s => <option key={s.id} value={s.id}>{s.display_name} · {s.environment}</option>)}</select></Field>
        {automation?.parameter_schema.map(field => <Field key={field.name} label={`${field.label}${field.required ? ' *' : ''}`} help={field.sensitive ? 'Sensitive value; avoid placing secrets in free-text fields.' : undefined}>
          {field.type === 'select' || field.type === 'multi-select' ? <select required={field.required} multiple={field.type === 'multi-select'} className={inputClass} value={field.type === 'multi-select' ? (values[field.name] as string[] || []) : String(values[field.name] || '')} onChange={e => updateValue(field.name, field.type === 'multi-select' ? Array.from(e.target.selectedOptions, x => x.value) : e.target.value)} data-testid={`input-param-${field.name}`}><option value="">Select {field.label.toLowerCase()}</option>{field.options?.map(option => <option key={option} value={option}>{option}</option>)}</select> :
          <input required={field.required} type={field.type === 'number' ? 'number' : field.sensitive ? 'password' : 'text'} min={field.min} max={field.max} placeholder={field.placeholder} className={inputClass} value={String(values[field.name] ?? '')} onChange={e => updateValue(field.name, field.type === 'number' ? Number(e.target.value) : e.target.value)} data-testid={`input-param-${field.name}`}/>}
        </Field>)}
        {automation?.requires_change_number && <Field label="Change number *" help="Required for change-controlled operations."><input required className={inputClass} placeholder="CHG-000000" value={change} onChange={e => setChange(e.target.value)} data-testid="input-change-number"/></Field>}
        <Field label="Business reason *" help="Add a short operational reason for this request (3–1000 characters)."><textarea required minLength={3} maxLength={1000} rows={3} className={inputClass} placeholder="Describe the operational need…" value={reason} onChange={e => setReason(e.target.value)} data-testid="input-business-reason"/></Field>
      </Card>
      <div className="space-y-4">
        <Card className="p-5"><h2 className="flex items-center gap-2 font-bold text-[#263b54]"><ShieldCheck size={17} className="text-[#1769c2]"/> Review before submit</h2>
          <div className="mt-4 space-y-3 text-sm"><div className="flex justify-between gap-3 border-b border-slate-100 pb-3"><span className="text-slate-500">Permission</span><span className="font-semibold capitalize text-[#334960]">{automation?.required_role || 'operator'} minimum</span></div><div className="flex justify-between gap-3 border-b border-slate-100 pb-3"><span className="text-slate-500">Expected duration</span><span className="font-semibold text-[#334960]">{automation ? `${automation.expected_minutes} min` : '—'}</span></div><div className="flex justify-between gap-3"><span className="text-slate-500">Execution mode</span><Badge tone="amber">Mock-aware</Badge></div></div>
          {automation?.requires_confirmation && <label className="mt-5 flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-950"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} data-testid="checkbox-run-confirmation" className="mt-1 accent-[#1769c2]"/>I have reviewed the selected automation and target. I understand this request will be recorded and may execute an approved action.</label>}
          {!automation?.requires_confirmation && automation && <label className="mt-5 flex items-start gap-2.5 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs leading-5 text-slate-700"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} data-testid="checkbox-run-confirmation" className="mt-1 accent-[#1769c2]"/>I confirm the request details and understand it will be recorded.</label>}
          {!canRun && automation && <p className="mt-3 text-xs font-semibold text-red-700">Your current role does not meet this automation's minimum requirement.</p>}
          {submit.isError && <p role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-xs text-red-700">{errorText(submit.error)}</p>}
          <Button type="submit" disabled={!automation || !serverId || !confirmed || !canRun || submit.isPending || !reason.trim()} testId="button-submit-run" className="mt-5 w-full">{submit.isPending ? <LoaderCircle size={16} className="animate-spin"/> : <Play size={15}/>} {submit.isPending ? 'Submitting request…' : 'Submit for execution'}</Button>
          <p className="mt-3 text-center text-[10px] leading-4 text-slate-400">Only registered automation keys can be submitted. No arbitrary scripts are accepted.</p>
        </Card>
      </div>
    </form>}
  </div>;
}

function JobsPage() {
  const [search, setSearch] = useState(''); const [status, setStatus] = useState(''); const [page, setPage] = useState(1); const [automationId, setAutomationId] = useState('');
  const params = useMemo(() => ({ page, page_size: 10, search: search || undefined, status: status || undefined, automation_id: automationId || undefined }), [page, search, status, automationId]);
  const query = useListJobs(params, { query: { queryKey: getListJobsQueryKey(params) } });
  const autos = useListAutomations(undefined, { query: { queryKey: getListAutomationsQueryKey() } });
  const exportMutation = useMutation({ mutationFn: () => exportJobs(), onSuccess: csv => {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' }); const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = 'automation-jobs.csv'; link.click(); URL.revokeObjectURL(url); notify('CSV export downloaded');
  } });
  const totalPages = query.data ? Math.max(1, Math.ceil(query.data.total / query.data.page_size)) : 1;
  return <div className="fade-in"><SectionTitle eyebrow="Execution records" title="Job history" detail="Search, review, and export traceable automation runs." action={<Button testId="button-export-jobs" kind="secondary" disabled={exportMutation.isPending} onClick={() => exportMutation.mutate()}><Download size={15}/>{exportMutation.isPending ? 'Preparing…' : 'Export CSV'}</Button>}/>
    {exportMutation.isError && <div className="mb-4"><ErrorPanel error={exportMutation.error}/></div>}
    <Card className="mb-4 p-4"><div className="grid gap-3 sm:grid-cols-[1fr_190px_220px]"><div className="relative"><Search size={16} className="absolute left-3 top-3 text-slate-400"/><input className={`${inputClass} pl-9`} placeholder="Search job, server, requester…" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} data-testid="input-jobs-search"/></div><select className={inputClass} value={status} onChange={e => { setStatus(e.target.value); setPage(1); }} data-testid="select-job-status"><option value="">All statuses</option>{['pending','validating','queued','running','successful','failed','cancelled','timed_out'].map(x => <option key={x} value={x}>{x.replaceAll('_',' ')}</option>)}</select><select className={inputClass} value={automationId} onChange={e => { setAutomationId(e.target.value); setPage(1); }} data-testid="select-job-automation"><option value="">All automations</option>{autos.data?.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div></Card>
    <Card className="overflow-hidden">
      {query.isLoading ? <div className="p-5"><Skeleton rows={7}/></div> : query.isError ? <div className="p-5"><ErrorPanel error={query.error} retry={() => query.refetch()}/></div> : !query.data?.items.length ? <Empty title="No jobs found" detail="Runs matching your filters will appear here. Adjust your search or submit an approved automation." action={<Link href="/run" data-testid="link-empty-run" className="font-semibold text-[#1769c2]">Submit an automation run</Link>}/> :
        <><div className="hidden grid-cols-[1.45fr_1fr_1fr_1fr_.8fr] gap-4 border-b border-slate-100 bg-[#f8fafc] px-5 py-3 text-[10px] font-bold uppercase tracking-[.1em] text-slate-500 md:grid"><span>Automation</span><span>Target</span><span>Requested by</span><span>Submitted</span><span>Status</span></div><div className="divide-y divide-slate-100">{query.data.items.map(job => <div key={job.id} className="grid gap-2 px-5 py-4 hover:bg-slate-50 md:grid-cols-[1.45fr_1fr_1fr_1fr_.8fr] md:items-center md:gap-4" data-testid={`row-job-${job.id}`}><Link href={`/jobs/${job.id}`} className="min-w-0 text-sm font-bold text-[#2a415b] hover:text-[#1769c2]">{job.automation_name}<span className="mono mt-1 block truncate text-[10px] font-normal text-slate-400">{job.id}</span></Link><span className="text-xs text-slate-600"><span className="mr-1 text-slate-400 md:hidden">Target:</span>{job.server_name}</span><span className="text-xs text-slate-600"><span className="mr-1 text-slate-400 md:hidden">By:</span>{job.requested_by}</span><span className="text-xs text-slate-500">{dateText(job.submitted_at)}</span><span><Status status={job.status}/></span></div>)}</div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-5 py-3"><p className="text-xs text-slate-500">Showing {query.data.items.length} of {query.data.total} jobs</p><div className="flex items-center gap-2"><Button kind="secondary" testId="button-jobs-prev" disabled={page <= 1} onClick={() => setPage(p => p - 1)}><ChevronLeft size={15}/>Previous</Button><span className="px-2 text-xs font-semibold text-slate-500" data-testid="text-jobs-page">Page {page} of {totalPages}</span><Button kind="secondary" testId="button-jobs-next" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next<ChevronRight size={15}/></Button></div></div></>}
    </Card>
  </div>;
}
function JobDetail({ id, user }: { id: string; user: User }) {
  const [, setLocation] = useLocation();
  const query = useGetJob(id, { query: { queryKey: getGetJobQueryKey(id), refetchInterval: 5000 } });
  const events = useGetJobEvents(id, { query: { queryKey: getGetJobEventsQueryKey(id), refetchInterval: 5000 } });
  const qc = useQueryClient(); const [confirm, setConfirm] = useState('');
  const cancel = useMutation({ mutationFn: () => cancelJob(id), onSuccess: () => { notify('Cancellation requested'); qc.invalidateQueries({ queryKey: getGetJobQueryKey(id) }); qc.invalidateQueries({ queryKey: getGetJobEventsQueryKey(id) }); } });
  const retry = useMutation({ mutationFn: () => retryJob(id), onSuccess: job => { notify('Retry job created'); qc.invalidateQueries({ queryKey: getGetJobQueryKey(id) }); setConfirm(''); setLocation(`/jobs/${job.id}`); } });
  const download = useMutation({ mutationFn: () => downloadJobLog(id), onSuccess: log => { const url = URL.createObjectURL(new Blob([log], { type: 'text/plain' })); const a = document.createElement('a'); a.href = url; a.download = `job-${id}-sanitized.log`; a.click(); URL.revokeObjectURL(url); notify('Sanitized log downloaded'); } });
  const job = query.data;
  if (query.isLoading) return <div><SectionTitle title="Job details"/><Card className="p-5"><Skeleton rows={5}/></Card></div>;
  if (query.isError) return <div><SectionTitle title="Job details"/><ErrorPanel error={query.error} retry={() => query.refetch()}/></div>;
  if (!job) return <Empty title="Job not available" detail="This job may have been removed or is not accessible." />;
  const terminal = ['successful','failed','cancelled','timed_out'].includes(job.status);
  return <div className="fade-in"><Link href="/jobs" data-testid="link-back-jobs" className="mb-4 inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-[#1769c2]"><ArrowLeft size={14}/> Job history</Link>
    <SectionTitle eyebrow={`Job ${job.id}`} title={job.automation_name} detail={`${job.server_name} · requested by ${job.requested_by}`} action={<div className="flex flex-wrap gap-2"><Button kind="secondary" testId="button-download-log" disabled={download.isPending} onClick={() => download.mutate()}><ArrowDownToLine size={15}/>{download.isPending ? 'Preparing…' : 'Download sanitized log'}</Button>{roleCan(user.role, 'operator') && !terminal && <Button kind="danger" testId="button-cancel-job" disabled={cancel.isPending || job.cancellation_requested} onClick={() => setConfirm('cancel')}>{job.cancellation_requested ? 'Cancellation requested' : 'Cancel job'}</Button>}{roleCan(user.role, 'operator') && ['failed','timed_out','cancelled'].includes(job.status) && <Button testId="button-retry-job" onClick={() => setConfirm('retry')}><RefreshCw size={15}/>Retry job</Button>}</div>}/>
    {confirm && <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4" data-testid="dialog-job-confirm"><div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"><div className={`mb-3 flex h-10 w-10 items-center justify-center rounded-xl ${confirm === 'cancel' ? 'bg-red-50 text-red-700' : 'bg-blue-50 text-blue-700'}`}>{confirm === 'cancel' ? <AlertTriangle size={19}/> : <RefreshCw size={18}/>}</div><h2 className="text-lg font-bold text-[#213750]">{confirm === 'cancel' ? 'Request cancellation?' : 'Retry this run?'}</h2><p className="mt-2 text-sm leading-6 text-slate-500">{confirm === 'cancel' ? 'A cancellation request will be recorded. The running process may take time to stop.' : 'A new job will be created using the same approved automation and parameters.'}</p><div className="mt-5 flex justify-end gap-2"><Button kind="secondary" testId="button-dialog-close" onClick={() => setConfirm('')}>Go back</Button><Button kind={confirm === 'cancel' ? 'danger' : 'primary'} testId="button-dialog-confirm" onClick={() => confirm === 'cancel' ? (cancel.mutate(), setConfirm('')) : retry.mutate()}>{confirm === 'cancel' ? 'Request cancellation' : 'Create retry'}</Button></div></div></div>}
    {(cancel.isError || retry.isError || download.isError) && <div className="mb-4"><ErrorPanel error={cancel.error || retry.error || download.error}/></div>}
    <div className="grid gap-5 xl:grid-cols-[1.25fr_.75fr]">
      <div className="space-y-5"><Card className="p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-[.12em] text-slate-400">Execution status</p><div className="mt-2 flex items-center gap-2"><Status status={job.status}/>{job.cancellation_requested && <Badge tone="amber">Cancellation requested</Badge>}</div></div><div className="text-right"><p className="text-xs text-slate-400">Submitted</p><p className="mt-1 text-sm font-semibold text-[#304660]">{dateText(job.submitted_at)}</p></div></div><div className="mt-5 grid gap-4 border-t border-slate-100 pt-4 sm:grid-cols-3"><KeyValue label="Started" value={dateText(job.started_at)}/><KeyValue label="Completed" value={dateText(job.completed_at)}/><KeyValue label="Duration" value={job.duration_seconds != null ? `${job.duration_seconds}s` : '—'}/><KeyValue label="Change number" value={job.change_number || '—'}/><KeyValue label="Return code" value={job.ansible_return_code == null ? '—' : String(job.ansible_return_code)}/><KeyValue label="Execution" value={job.mock_result ? 'Mock result' : 'Standard'}/></div>{job.error_summary && <div className="mt-4 rounded-lg border border-red-100 bg-red-50 p-3 text-sm text-red-800"><strong>Failure summary</strong><p className="mt-1">{job.error_summary}</p></div>}</Card>
        <Card><div className="border-b border-slate-100 px-5 py-4"><h2 className="font-bold text-[#243950]">Sanitized output</h2><p className="mt-1 text-xs text-slate-500">Sensitive values are redacted before display.</p></div><div className="space-y-4 p-5"><OutputBlock label="Standard output" value={job.sanitized_stdout}/><OutputBlock label="Standard error" value={job.sanitized_stderr}/></div></Card>
        <Card><div className="border-b border-slate-100 px-5 py-4"><h2 className="font-bold text-[#243950]">Submitted parameters</h2></div><dl className="grid gap-x-6 gap-y-4 p-5 sm:grid-cols-2">{Object.entries(job.parameters || {}).map(([key, value]) => <div key={key}><dt className="text-[10px] font-bold uppercase tracking-[.1em] text-slate-400">{key.replaceAll('_',' ')}</dt><dd className="mt-1 break-words text-sm text-[#324961]">{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd></div>)}</dl><div className="border-t border-slate-100 px-5 py-4"><p className="text-[10px] font-bold uppercase tracking-[.1em] text-slate-400">Business reason</p><p className="mt-1 text-sm leading-6 text-[#324961]">{job.business_reason}</p></div></Card></div>
      <Card className="p-5"><div className="flex items-center justify-between"><div><h2 className="font-bold text-[#243950]">Event timeline</h2><p className="mt-1 text-xs text-slate-500">Automatically refreshes every 5 seconds</p></div><span className="flex items-center gap-1 text-[10px] font-semibold text-emerald-700"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500"/>Live</span></div>
        {events.isError && <div className="mt-4"><ErrorPanel error={events.error} retry={() => events.refetch()}/></div>}
        {events.isLoading ? <div className="mt-5"><Skeleton rows={4}/></div> : !events.data?.length ? <Empty title="No timeline events" detail="Event updates will be listed here as the job progresses."/> : <ol className="mt-6 space-y-0">{events.data.map((event, index) => <li key={event.id} className="relative flex gap-3 pb-6 last:pb-0" data-testid={`event-${event.id}`}><div className="relative flex w-5 shrink-0 justify-center"><span className={`mt-1 h-2.5 w-2.5 rounded-full ring-4 ring-white ${index === 0 ? 'bg-[#1769c2]' : 'bg-slate-300'}`}/>{index < (events.data?.length || 0) - 1 && <span className="absolute top-4 h-full w-px bg-slate-200"/>}</div><div className="min-w-0"><p className="text-sm font-bold capitalize text-[#304660]">{event.event_type.replaceAll('_',' ')}</p><p className="mt-1 text-xs leading-5 text-slate-500">{event.message}</p><p className="mono mt-1.5 text-[9px] text-slate-400">{dateText(event.created_at)}</p></div></li>)}</ol>}
      </Card>
    </div>
  </div>;
}
function KeyValue({ label, value }: { label: string; value: string }) { return <div><p className="text-[10px] font-bold uppercase tracking-[.1em] text-slate-400">{label}</p><p className="mt-1 text-sm font-semibold text-[#344a62]">{value}</p></div>; }
function OutputBlock({ label, value }: { label: string; value?: string | null }) { return <div><p className="mb-2 text-xs font-bold text-slate-500">{label}</p><pre className="max-h-64 overflow-auto rounded-lg bg-[#f3f6f9] p-3 font-mono text-[11px] leading-5 text-[#33475e]">{value || 'No output recorded.'}</pre></div>; }

function ServersPage({ user }: { user: User }) {
  const admin = user.role === 'admin'; const query = useListServers({ query: { queryKey: getListServersQueryKey() } });
  const qc = useQueryClient(); const [editing, setEditing] = useState<ServerRecord | 'new' | null>(null); const [testResults, setTestResults] = useState<Record<string, string>>({});
  const test = useMutation({ mutationFn: (id: string) => testServerConnection(id), onSuccess: (result, id) => { setTestResults(prev => ({ ...prev, [id]: `${result.mock ? 'Simulated test' : 'Connection test'}: ${result.message}` })); notify(result.mock ? 'Simulated connection test completed' : 'Connection test completed'); qc.invalidateQueries({ queryKey: getListServersQueryKey() }); } });
  return <div className="fade-in"><SectionTitle eyebrow="Infrastructure inventory" title="Servers" detail="Manage approved Windows targets and their connection references." action={admin ? <Button testId="button-add-server" onClick={() => setEditing('new')}><Plus size={15}/>Add server</Button> : undefined}/>
    {query.isLoading ? <Skeleton rows={4}/> : query.isError ? <ErrorPanel error={query.error} retry={() => query.refetch()}/> : !query.data?.length ? <Card><Empty title="No servers registered" detail="Server targets must be registered by an administrator before automation runs can use them." action={admin ? <Button testId="button-empty-add-server" onClick={() => setEditing('new')}><Plus size={15}/>Register a server</Button> : undefined}/></Card> :
      <Card className="overflow-hidden"><div className="hidden grid-cols-[1.2fr_1.2fr_.8fr_.8fr_.8fr] gap-4 border-b border-slate-100 bg-[#f8fafc] px-5 py-3 text-[10px] font-bold uppercase tracking-[.1em] text-slate-500 md:grid"><span>Server</span><span>Hostname</span><span>Environment</span><span>Connection</span><span>Status</span></div><div className="divide-y divide-slate-100">{query.data.map(server => <div key={server.id} className="grid gap-3 px-5 py-4 md:grid-cols-[1.2fr_1.2fr_.8fr_.8fr_.8fr] md:items-center md:gap-4" data-testid={`row-server-${server.id}`}><div><p className="text-sm font-bold text-[#2b415b]">{server.display_name}</p><p className="mono mt-1 text-[10px] text-slate-400">{server.name}</p></div><div><p className="text-xs text-slate-600">{server.hostname}</p><p className="mt-1 text-[10px] text-slate-400">{server.operating_system} · port {server.winrm_port}</p></div><div className="text-xs text-slate-600">{server.environment}</div><div><Status status={server.last_connection_status || 'not tested'}/>{server.last_connection_at && <p className="mt-1 text-[9px] text-slate-400">{dateText(server.last_connection_at)}</p>}</div><div className="flex flex-wrap items-center gap-2"><Badge tone={server.is_active ? 'green' : 'slate'}>{server.is_active ? 'Active' : 'Inactive'}</Badge>{admin && <div className="flex gap-1"><Button kind="quiet" testId={`button-test-server-${server.id}`} disabled={test.isPending} onClick={() => test.mutate(server.id)}>{test.isPending ? <LoaderCircle size={14} className="animate-spin"/> : <Activity size={14}/>}Test</Button><Button kind="secondary" testId={`button-edit-server-${server.id}`} onClick={() => setEditing(server)}>Edit</Button><Button kind="quiet" testId={`button-toggle-server-${server.id}`} onClick={async () => { try { await setServerStatus(server.id, { is_active: !server.is_active }); notify(server.is_active ? 'Server deactivated' : 'Server activated'); qc.invalidateQueries({ queryKey: getListServersQueryKey() }); } catch (e) { notify(errorText(e)); } }}>{server.is_active ? 'Disable' : 'Enable'}</Button></div>}</div>{testResults[server.id] && <p className="col-span-full text-xs text-slate-500" data-testid={`text-test-result-${server.id}`}>{testResults[server.id]} <span className="font-semibold text-amber-700">Mock mode does not verify real WinRM.</span></p>}</div>)}</div></Card>}
    {test.isError && <div className="mt-4"><ErrorPanel error={test.error}/></div>}
    {editing && <ServerEditor server={editing === 'new' ? undefined : editing} close={() => setEditing(null)} saved={() => { setEditing(null); qc.invalidateQueries({ queryKey: getListServersQueryKey() }); }}/>}
  </div>;
}
function ServerEditor({ server, close, saved }: { server?: ServerRecord; close: () => void; saved: () => void }) {
  const [form, setForm] = useState<ServerInput>({ name: server?.name || '', display_name: server?.display_name || '', hostname: server?.hostname || '', environment: server?.environment || 'production', operating_system: server?.operating_system || 'Windows Server', winrm_port: server?.winrm_port || 5986, use_https: server?.use_https ?? true, certificate_validation: server?.certificate_validation || 'validate', credential_reference: server?.credential_reference || '', is_active: server?.is_active ?? true });
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function save(e: FormEvent) { e.preventDefault(); setBusy(true); setError(''); try { if (server) await updateServer(server.id, form); else await createServer(form); notify(server ? 'Server updated' : 'Server registered'); saved(); } catch (err) { setError(errorText(err)); } finally { setBusy(false); } }
  const field = (key: keyof ServerInput, val: string | number | boolean) => setForm(prev => ({ ...prev, [key]: val }));
  return <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4" data-testid="dialog-server-editor"><form onSubmit={save} className="max-h-[92dvh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl"><div className="flex items-center justify-between"><div><h2 className="text-lg font-bold text-[#203750]">{server ? 'Edit server' : 'Register server'}</h2><p className="mt-1 text-xs text-slate-500">Credentials are referenced, never entered or displayed here.</p></div><button type="button" aria-label="Close" data-testid="button-close-server-editor" className="rounded-lg p-2 hover:bg-slate-100" onClick={close}><X size={18}/></button></div>
    <div className="mt-5 grid gap-4 sm:grid-cols-2"><Field label="Internal name"><input required className={inputClass} value={form.name} onChange={e => field('name', e.target.value)} data-testid="input-server-name"/></Field><Field label="Display name"><input required className={inputClass} value={form.display_name} onChange={e => field('display_name', e.target.value)} data-testid="input-server-display-name"/></Field><Field label="Hostname"><input required className={inputClass} value={form.hostname} onChange={e => field('hostname', e.target.value)} data-testid="input-server-hostname"/></Field><Field label="Environment"><select className={inputClass} value={form.environment} onChange={e => field('environment', e.target.value)} data-testid="select-server-environment">{['production','staging','development','test'].map(x => <option key={x}>{x}</option>)}</select></Field><Field label="Operating system"><input required className={inputClass} value={form.operating_system} onChange={e => field('operating_system', e.target.value)} data-testid="input-server-os"/></Field><Field label="WinRM port"><input type="number" min="1" max="65535" required className={inputClass} value={form.winrm_port} onChange={e => field('winrm_port', Number(e.target.value))} data-testid="input-server-port"/></Field><Field label="Certificate validation"><select className={inputClass} value={form.certificate_validation} onChange={e => field('certificate_validation', e.target.value)} data-testid="select-cert-validation"><option value="validate">Validate certificate</option><option value="ignore">Ignore certificate validation</option></select></Field><Field label="Credential reference"><input required className={inputClass} value={form.credential_reference} onChange={e => field('credential_reference', e.target.value)} placeholder="vault://credential/reference" data-testid="input-credential-reference"/></Field></div>
    <div className="mt-4 flex flex-wrap gap-5"><label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={form.use_https} onChange={e => field('use_https', e.target.checked)} data-testid="checkbox-server-https"/>Use HTTPS</label><label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={form.is_active} onChange={e => field('is_active', e.target.checked)} data-testid="checkbox-server-active"/>Active target</label></div>
    {error && <div role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}<div className="mt-6 flex justify-end gap-2"><Button kind="secondary" testId="button-cancel-server" onClick={close}>Cancel</Button><Button type="submit" testId="button-save-server" disabled={busy}>{busy && <LoaderCircle size={15} className="animate-spin"/>}{server ? 'Save changes' : 'Register server'}</Button></div>
  </form></div>;
}

function AutomationAdmin() {
  const query = useListAutomations(undefined, { query: { queryKey: getListAutomationsQueryKey() } }); const qc = useQueryClient(); const [editing, setEditing] = useState<Automation | 'new' | null>(null);
  return <div className="fade-in"><SectionTitle eyebrow="Governance" title="Automation administration" detail="Manage approved automation records. Script and playbook keys must come from the registered catalogue." action={<Button testId="button-add-automation" onClick={() => setEditing('new')}><Plus size={15}/>Add automation</Button>}/>
    <div className="mb-4 flex items-start gap-2 rounded-lg border border-blue-100 bg-blue-50 p-3 text-xs leading-5 text-blue-900"><ShieldCheck size={15} className="mt-0.5 shrink-0"/>Script execution is constrained to registered keys. This portal does not accept arbitrary PowerShell source.</div>
    {query.isLoading ? <Skeleton rows={5}/> : query.isError ? <ErrorPanel error={query.error} retry={() => query.refetch()}/> : !query.data?.length ? <Card><Empty title="No automation records" detail="Registered automation records will be listed here when the service is available."/></Card> : <Card className="overflow-hidden"><div className="divide-y divide-slate-100">{query.data.map(a => <div key={a.id} className="flex flex-wrap items-center justify-between gap-4 px-5 py-4" data-testid={`row-admin-automation-${a.id}`}><div><p className="text-sm font-bold text-[#2c425a]">{a.name} <span className="mono ml-2 text-[10px] font-normal text-slate-400">{a.code}</span></p><p className="mt-1 text-xs text-slate-500">Playbook: {a.playbook_key} · Script: {a.powershell_script_key}</p></div><div className="flex items-center gap-2"><Badge tone={a.is_active ? 'green' : 'slate'}>{a.is_active ? 'Active' : 'Inactive'}</Badge><Badge tone={a.risk_level === 'high' ? 'red' : a.risk_level === 'medium' ? 'amber' : 'green'}>{a.risk_level}</Badge><Button kind="secondary" testId={`button-edit-automation-${a.id}`} onClick={() => setEditing(a)}>Edit</Button><Button kind="quiet" testId={`button-toggle-automation-${a.id}`} onClick={async () => { try { await setAutomationStatus(a.id, { is_active: !a.is_active }); notify(a.is_active ? 'Automation deactivated' : 'Automation activated'); qc.invalidateQueries({ queryKey: getListAutomationsQueryKey() }); } catch (e) { notify(errorText(e)); } }}>{a.is_active ? 'Deactivate' : 'Activate'}</Button></div></div>)}</div></Card>}
    {editing && query.data && <AutomationEditor item={editing === 'new' ? undefined : editing} registry={query.data} close={() => setEditing(null)} saved={() => { setEditing(null); qc.invalidateQueries({ queryKey: getListAutomationsQueryKey() }); }}/>}
  </div>;
}
function AutomationEditor({ item, registry, close, saved }: { item?: Automation; registry: Automation[]; close: () => void; saved: () => void }) {
  const template = registry[0];
  const [form, setForm] = useState<AutomationInput>({
    code: item?.code || '', name: item?.name || '', description: item?.description || '',
    playbook_key: item?.playbook_key || template?.playbook_key || '', powershell_script_key: item?.powershell_script_key || template?.powershell_script_key || '',
    parameter_schema: item?.parameter_schema || [], risk_level: item?.risk_level || 'low', timeout_seconds: item?.timeout_seconds || 300,
    required_role: item?.required_role || 'operator', requires_change_number: item?.requires_change_number || false,
    requires_confirmation: item?.requires_confirmation ?? true, is_active: item?.is_active ?? true
  });
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const playbooks = Array.from(new Set(registry.map(r => r.playbook_key).filter(Boolean))); const scripts = Array.from(new Set(registry.map(r => r.powershell_script_key).filter(Boolean)));
  async function save(e: FormEvent) { e.preventDefault(); setBusy(true); setError(''); try { if (item) await updateAutomation(item.id, form); else await createAutomation(form); notify(item ? 'Automation updated' : 'Automation registered'); saved(); } catch (err) { setError(errorText(err)); } finally { setBusy(false); } }
  const patch = (key: keyof AutomationInput, value: unknown) => setForm(prev => ({ ...prev, [key]: value }));
  return <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4"><form onSubmit={save} className="max-h-[92dvh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl" data-testid="dialog-automation-editor"><div className="flex items-center justify-between"><div><h2 className="text-lg font-bold text-[#203750]">{item ? 'Edit automation' : 'Register automation'}</h2><p className="mt-1 text-xs text-slate-500">Keys are selectable only from existing registered records.</p></div><button type="button" data-testid="button-close-automation-editor" aria-label="Close" onClick={close}><X size={18}/></button></div>
    <div className="mt-5 grid gap-4 sm:grid-cols-2"><Field label="Automation code"><input required className={inputClass} value={form.code} onChange={e => patch('code', e.target.value)} data-testid="input-automation-code"/></Field><Field label="Name"><input required className={inputClass} value={form.name} onChange={e => patch('name', e.target.value)} data-testid="input-automation-name"/></Field><div className="sm:col-span-2"><Field label="Description"><textarea required rows={2} className={inputClass} value={form.description} onChange={e => patch('description', e.target.value)} data-testid="input-automation-description"/></Field></div>
    <Field label="Registered playbook key"><select required className={inputClass} value={form.playbook_key} onChange={e => patch('playbook_key', e.target.value)} data-testid="select-playbook-key"><option value="">Choose registered key</option>{playbooks.map(k => <option key={k}>{k}</option>)}</select></Field>
    <Field label="Registered PowerShell key"><select required className={inputClass} value={form.powershell_script_key} onChange={e => patch('powershell_script_key', e.target.value)} data-testid="select-powershell-key"><option value="">Choose registered key</option>{scripts.map(k => <option key={k}>{k}</option>)}</select></Field>
    <Field label="Risk level"><select className={inputClass} value={form.risk_level} onChange={e => patch('risk_level', e.target.value)} data-testid="select-automation-risk"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></Field>
    <Field label="Required role"><select className={inputClass} value={form.required_role} onChange={e => patch('required_role', e.target.value)} data-testid="select-required-role"><option value="viewer">Viewer</option><option value="operator">Operator</option><option value="admin">Administrator</option></select></Field>
    <Field label="Timeout (seconds)"><input type="number" min="1" max="3600" required className={inputClass} value={form.timeout_seconds} onChange={e => patch('timeout_seconds', Number(e.target.value))} data-testid="input-automation-timeout"/></Field></div>
    <div className="mt-4 flex flex-wrap gap-5"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.requires_change_number} onChange={e => patch('requires_change_number', e.target.checked)} data-testid="checkbox-requires-change"/>Requires change number</label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.requires_confirmation} onChange={e => patch('requires_confirmation', e.target.checked)} data-testid="checkbox-requires-confirmation"/>Requires confirmation</label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.is_active} onChange={e => patch('is_active', e.target.checked)} data-testid="checkbox-automation-active"/>Active</label></div>
    {!playbooks.length || !scripts.length ? <p className="mt-3 text-xs font-semibold text-amber-800">No registered keys are available. Additions are disabled until a registered automation record provides keys.</p> : null}{error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
    <div className="mt-6 flex justify-end gap-2"><Button kind="secondary" testId="button-cancel-automation" onClick={close}>Cancel</Button><Button type="submit" testId="button-save-automation" disabled={busy || (!item && (!playbooks.length || !scripts.length))}>{busy && <LoaderCircle size={15} className="animate-spin"/>}{item ? 'Save changes' : 'Register automation'}</Button></div>
  </form></div>;
}

function AuditPage() {
  const [search, setSearch] = useState(''); const [page, setPage] = useState(1);
  const params = useMemo(() => ({ page, page_size: 20, search: search || undefined }), [page, search]);
  const query = useListAuditLogs(params, { query: { queryKey: getListAuditLogsQueryKey(params) } });
  const pages = query.data ? Math.max(1, Math.ceil(query.data.total / query.data.page_size)) : 1;
  return <div className="fade-in"><SectionTitle eyebrow="Governance" title="Audit log" detail="Recorded administrative and operational actions."/>
    <Card className="mb-4 p-4"><div className="relative max-w-lg"><Search size={16} className="absolute left-3 top-3 text-slate-400"/><input className={`${inputClass} pl-9`} placeholder="Search actions, users, resources…" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} data-testid="input-audit-search"/></div></Card>
    <Card className="overflow-hidden">{query.isLoading ? <div className="p-5"><Skeleton rows={6}/></div> : query.isError ? <div className="p-5"><ErrorPanel error={query.error} retry={() => query.refetch()}/></div> : !query.data?.items.length ? <Empty title="No audit entries" detail="Recorded administrative changes and run events will appear here."/> : <><div className="divide-y divide-slate-100">{query.data.items.map(entry => <div key={entry.id} className="grid gap-2 px-5 py-4 sm:grid-cols-[1fr_1fr_1fr_1.3fr] sm:items-start" data-testid={`row-audit-${entry.id}`}><div><p className="text-sm font-bold capitalize text-[#2c425a]">{entry.action.replaceAll('_',' ')}</p><p className="mono mt-1 text-[9px] text-slate-400">{entry.resource_type}{entry.resource_id ? ` · ${entry.resource_id}` : ''}</p></div><p className="text-xs text-slate-600">{entry.user_name}</p><p className="text-xs text-slate-500">{dateText(entry.created_at)}</p><details className="text-xs text-slate-500"><summary className="cursor-pointer font-semibold text-[#1769c2]">View details</summary><pre className="mt-2 overflow-auto rounded bg-slate-50 p-2 text-[10px]">{JSON.stringify(entry.details, null, 2)}</pre></details></div>)}</div><div className="flex items-center justify-between border-t border-slate-100 px-5 py-3"><span className="text-xs text-slate-500">{query.data.total} entries · page {page} of {pages}</span><div className="flex gap-2"><Button kind="secondary" testId="button-audit-prev" disabled={page <= 1} onClick={() => setPage(p => p - 1)}><ChevronLeft size={15}/>Previous</Button><Button kind="secondary" testId="button-audit-next" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Next<ChevronRight size={15}/></Button></div></div></>}</Card>
  </div>;
}
function Profile({ user }: { user: User }) {
  const [, setLocation] = useLocation(); const qc = useQueryClient(); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function signOut() { setBusy(true); setError(''); try { await logout(); qc.clear(); setLocation('/login'); notify('You have signed out'); } catch (err) { setError(errorText(err)); } finally { setBusy(false); } }
  const [theme, setTheme] = useState(localStorage.getItem('portal-theme') || 'light');
  useEffect(() => { document.documentElement.classList.toggle('dark', theme === 'dark'); }, [theme]);
  function changeTheme(value: string) { setTheme(value); localStorage.setItem('portal-theme', value); document.documentElement.classList.toggle('dark', value === 'dark'); }
  return <div className="fade-in"><SectionTitle eyebrow="Account" title="Profile & preferences" detail="Your access identity and workspace settings."/>
    {error && <div className="mb-4"><ErrorPanel error={error}/></div>}
    <div className="grid gap-5 lg:grid-cols-[1.15fr_.85fr]"><Card className="p-6"><div className="flex items-center gap-4 border-b border-slate-100 pb-5"><span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#eaf1f8] text-lg font-bold text-[#355675]">{initials(user.full_name)}</span><div><h2 className="text-lg font-bold text-[#263b54]">{user.full_name}</h2><p className="mt-1 text-sm text-slate-500">{user.email}</p></div></div><dl className="mt-5 space-y-4"><KeyValue label="Account ID" value={user.id}/><div className="flex items-center justify-between"><dt className="text-xs font-bold uppercase tracking-[.1em] text-slate-400">Role</dt><dd><Badge tone={user.role === 'admin' ? 'blue' : user.role === 'operator' ? 'green' : 'slate'}>{user.role}</Badge></dd></div><div className="flex items-center justify-between"><dt className="text-xs font-bold uppercase tracking-[.1em] text-slate-400">Account status</dt><dd><Badge tone={user.is_active ? 'green' : 'red'}>{user.is_active ? 'Active' : 'Disabled'}</Badge></dd></div></dl></Card>
    <div className="space-y-5"><Card className="p-6"><h2 className="font-bold text-[#263b54]">Appearance</h2><p className="mt-1 text-sm text-slate-500">Choose a comfortable interface theme.</p><div className="mt-4 flex gap-2"><Button kind={theme === 'light' ? 'primary' : 'secondary'} testId="button-theme-light" onClick={() => changeTheme('light')}>Light</Button><Button kind={theme === 'dark' ? 'primary' : 'secondary'} testId="button-theme-dark" onClick={() => changeTheme('dark')}>Dark</Button></div></Card>
      <Card className="p-6"><h2 className="font-bold text-[#263b54]">Session</h2><p className="mt-1 text-sm leading-6 text-slate-500">Sign out of the current development session on this device.</p><Button kind="danger" testId="button-logout" disabled={busy} onClick={signOut} className="mt-4"><LogOut size={15}/>{busy ? 'Signing out…' : 'Sign out'}</Button></Card>
    </div></div>
  </div>;
}
function NotFound() { return <div className="mx-auto max-w-lg py-24 text-center"><div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-[#edf4fb] text-[#1769c2]"><Search size={21}/></div><h1 className="mt-4 text-2xl font-bold text-[#203750]">Page not found</h1><p className="mt-2 text-sm text-slate-500">This route does not exist in the operations portal.</p><Link href="/dashboard" className="mt-5 inline-flex font-semibold text-[#1769c2]" data-testid="link-not-found-home">Back to overview <ArrowRight size={15} className="ml-1"/></Link></div>; }
function Authenticated({ children }: { children: (user: User) => ReactNode }) {
  const userQuery = useUser(); const [location, setLocation] = useLocation();
  useEffect(() => { if (userQuery.isError && location !== '/login') setLocation('/login'); }, [userQuery.isError, location, setLocation]);
  if (userQuery.isLoading) return <div className="min-h-[100dvh] bg-[#f3f6fa] p-8"><div className="mx-auto max-w-5xl"><div className="mb-7 h-12 w-full animate-pulse rounded-xl bg-white"/><Skeleton rows={6}/></div></div>;
  if (userQuery.isError || !userQuery.data) return <LoginPage sessionError={userQuery.error}/>;
  return <PortalShell user={userQuery.data}>{children(userQuery.data)}</PortalShell>;
}
function Router() {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}><Switch>
    <Route path="/login"><LoginPage/></Route>
    <Route path="/"><Authenticated>{user => <Dashboard user={user}/>}</Authenticated></Route>
    <Route path="/dashboard"><Authenticated>{user => <Dashboard user={user}/>}</Authenticated></Route>
    <Route path="/automations"><Authenticated>{user => <Automations user={user}/>}</Authenticated></Route>
    <Route path="/run"><Authenticated>{() => <RunPage/>}</Authenticated></Route>
    <Route path="/jobs"><Authenticated>{() => <JobsPage/>}</Authenticated></Route>
    <Route path="/jobs/:id">{params => <Authenticated>{user => <JobDetail id={params.id || ''} user={user}/>}</Authenticated>}</Route>
    <Route path="/servers"><Authenticated>{user => <ServersPage user={user}/>}</Authenticated></Route>
    <Route path="/admin/automations"><Authenticated>{user => user.role === 'admin' ? <AutomationAdmin/> : <AccessDenied/>}</Authenticated></Route>
    <Route path="/audit"><Authenticated>{user => user.role === 'admin' ? <AuditPage/> : <AccessDenied/>}</Authenticated></Route>
    <Route path="/profile"><Authenticated>{user => <Profile user={user}/>}</Authenticated></Route>
    <Route><Authenticated>{() => <NotFound/>}</Authenticated></Route>
  </Switch></ErrorBoundary>;
}
function AccessDenied() { return <Card className="p-10 text-center"><span className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-amber-50 text-amber-700"><Shield size={22}/></span><h1 className="mt-4 text-xl font-bold text-[#243950]">Administrator access required</h1><p className="mt-2 text-sm text-slate-500">Your role does not have permission to open this governance area.</p><Link href="/dashboard" className="mt-5 inline-flex font-semibold text-[#1769c2]" data-testid="link-access-denied-home">Return to overview</Link></Card>; }
function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router/></WouterRouter><ToastHost/><Toaster/></TooltipProvider></QueryClientProvider>;
}
export default App;
