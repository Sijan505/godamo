/**
 * Dashboard: today's figures, alerts, 7-day sales chart, top debtors and
 * recent invoices. Refreshes every minute while the tab is visible and when
 * the window regains focus.
 */
import { ApiError, apiFetch } from '../api.js';
import { compactNPR, esc, formatNPR, toNumber } from '../format.js';
import { icon } from '../icons.js';
import { formatAD, isoToBS, isoToBSShort } from '../nepali-date.js';

const REFRESH_MS = 60_000;
const STALE_MS = 30_000;

/** Draws the dashboard into `main`; returns a function that stops its timers. */
export function renderDashboard(main) {
  main.innerHTML = `
    <div class="page-inner">
      <div class="page-head">
        <div>
          <h1 class="page-title">Dashboard</h1>
          <p class="muted" style="font-size: 0.875rem" id="dash-sub">Today at a glance</p>
        </div>
        <button type="button" class="btn btn-outline btn-sm" id="dash-refresh">${icon('RotateCw')} Refresh</button>
      </div>
      <div id="dash-body" style="display: grid; gap: 1.5rem">${skeleton()}</div>
    </div>`;
  const body = main.querySelector('#dash-body');
  const sub = main.querySelector('#dash-sub');
  const refreshBtn = main.querySelector('#dash-refresh');

  let updatedAt = 0;
  let loading = false;
  let hasData = false;
  let stopped = false;
  let chartCleanup = null;

  async function load() {
    if (loading || stopped) return;
    loading = true;
    refreshBtn.disabled = true;
    refreshBtn.querySelector('svg').classList.add('spin');
    try {
      const data = await fetchWithRetry();
      if (stopped) return;
      updatedAt = Date.now();
      hasData = true;
      sub.textContent = `Updated ${new Date(updatedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} · refreshes every minute`;
      chartCleanup?.();
      body.innerHTML = content(data);
      chartCleanup = drawChart(body.querySelector('#sales-chart'), data.salesLast7Days);
    } catch (e) {
      if (stopped) return;
      // Keep showing the last good figures if a background refresh fails.
      if (!hasData) {
        body.innerHTML = errorState(e instanceof ApiError ? e.message : 'Something went wrong.');
        body.querySelector('#dash-retry').addEventListener('click', load);
      }
    } finally {
      loading = false;
      refreshBtn.disabled = false;
      refreshBtn.querySelector('svg').classList.remove('spin');
    }
  }

  refreshBtn.addEventListener('click', load);
  const timer = setInterval(() => {
    if (document.visibilityState === 'visible') load();
  }, REFRESH_MS);
  const onFocus = () => {
    if (Date.now() - updatedAt > STALE_MS) load();
  };
  window.addEventListener('focus', onFocus);
  load();

  return () => {
    stopped = true;
    clearInterval(timer);
    window.removeEventListener('focus', onFocus);
    chartCleanup?.();
  };
}

/** Network and server errors are retried twice; auth/permission/validation errors are not. */
async function fetchWithRetry(attempt = 0) {
  try {
    return await apiFetch('/dashboard/summary');
  } catch (e) {
    if (e instanceof ApiError && e.status < 500) throw e;
    if (attempt >= 2) throw e;
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    return fetchWithRetry(attempt + 1);
  }
}

// ─── Markup ─────────────────────────────────────────────────────────────────

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function content(d) {
  const hasOverdue = toNumber(d.receivable.overdue) > 0;
  const collectionHint = d.todayCollections.byMethod.length
    ? d.todayCollections.byMethod.map((m) => `${m.method} ${formatNPR(m.total)}`).join(' · ')
    : 'No receipts yet today';

  return `
    <section aria-label="Key figures" class="grid-stats">
      ${statCard({ label: "Today's sales", value: formatNPR(d.todaySales.total), hint: plural(d.todaySales.invoiceCount, 'invoice', 'invoices'), icon: 'TrendingUp', href: '/sales/invoices' })}
      ${statCard({ label: "Today's collections", value: formatNPR(d.todayCollections.total), hint: collectionHint, icon: 'HandCoins', tone: 'success', href: '/payments' })}
      ${statCard({ label: 'Total receivable', value: formatNPR(d.receivable.total), hint: 'Owed by all parties', icon: 'Wallet', tone: 'saffron', href: '/reports' })}
      ${statCard({ label: 'Overdue', value: formatNPR(d.receivable.overdue), hint: hasOverdue ? "Past the party's credit days" : 'Nothing overdue', icon: 'AlertTriangle', tone: hasOverdue ? 'danger' : 'success', href: '/reports' })}
      ${statCard({ label: 'Low stock', value: plural(d.lowStockCount, 'product', 'products'), hint: 'At or below reorder level', icon: 'Boxes', tone: d.lowStockCount ? 'warning' : 'default', href: '/stock' })}
      ${statCard({ label: 'Expiring soon', value: plural(d.expiringSoonCount, 'batch', 'batches'), hint: 'Within 30 days (incl. expired)', icon: 'CalendarClock', tone: d.expiringSoonCount ? 'warning' : 'default', href: '/stock' })}
    </section>

    <section aria-label="Needs attention" class="grid-alerts">
      ${alertLink('/parties', d.pendingCreditApprovals, 'Credit approvals waiting', 'BadgeCheck')}
      ${alertLink('/payments', d.pendingHandovers, 'Cash handovers to verify', 'Receipt')}
    </section>

    <div class="grid-split">
      <div class="card span-3">
        <div class="card-header">
          <h2 class="card-title">Sales, last 7 days</h2>
          <p class="card-description">Issued invoices by day (BS dates)</p>
        </div>
        <div class="card-content">${chartFigure(d.salesLast7Days)}</div>
      </div>

      <div class="card span-2">
        <div class="card-header">
          <h2 class="card-title">Top debtors</h2>
          <p class="card-description">Highest balances; 90+ days highlighted</p>
        </div>
        <div class="card-content tight">
          ${
            d.topDebtors.length
              ? `<div class="table-wrap"><table class="table">
                  <thead><tr><th>Party</th><th class="text-right">Balance</th><th class="text-right">90+ days</th></tr></thead>
                  <tbody>${d.topDebtors
                    .map((t) => {
                      const old = toNumber(t.over90Days) > 0;
                      return `<tr>
                        <td class="cell-name sm font-medium" title="${esc(t.party.name)}">${esc(t.party.name)}</td>
                        <td class="text-right num">${esc(formatNPR(t.balance))}</td>
                        <td class="text-right num ${old ? 'font-semibold text-danger' : 'muted'}">${old ? esc(formatNPR(t.over90Days)) : '–'}</td>
                      </tr>`;
                    })
                    .join('')}</tbody>
                </table></div>`
              : '<p class="empty-text">No one owes you money right now.</p>'
          }
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header with-action">
        <div style="display: grid; gap: 0.375rem">
          <h2 class="card-title">Recent invoices</h2>
          <p class="card-description">Last 8 invoices</p>
        </div>
        <a href="/sales/invoices" data-link class="btn btn-ghost btn-sm" style="align-self: center">All invoices ${icon('ArrowRight')}</a>
      </div>
      <div class="card-content tight">
        ${
          d.recentInvoices.length
            ? `<div class="table-wrap"><table class="table">
                <thead><tr><th>Invoice</th><th>Date</th><th>Party</th><th class="text-right">Amount</th><th>Status</th></tr></thead>
                <tbody>${d.recentInvoices
                  .map(
                    (inv) => `<tr>
                      <td class="font-medium num">${esc(inv.fiscalYear)}-${esc(inv.invoiceNo)}</td>
                      <td class="date-cell"><span class="bs">${esc(isoToBS(inv.invoiceDate))}</span><span class="ad">${esc(formatAD(inv.invoiceDate))}</span></td>
                      <td class="cell-name" title="${esc(inv.party.name)}">${esc(inv.party.name)}</td>
                      <td class="text-right num${inv.status === 'CANCELLED' ? ' cell-strike' : ''}">${esc(formatNPR(inv.total))}</td>
                      <td>${paymentBadge(inv.paymentStatus, inv.isOverdue)}</td>
                    </tr>`,
                  )
                  .join('')}</tbody>
              </table></div>`
            : '<p class="empty-text">No invoices yet.</p>'
        }
      </div>
    </div>`;
}

function statCard({ label, value, hint, icon: name, tone = 'default', href }) {
  return `<a href="${href}" data-link class="stat-link">
    <div class="card stat tone-${tone}">
      <div class="stat-top">
        <p class="stat-label">${esc(label)}</p>
        <span class="stat-icon">${icon(name, 'size-5')}</span>
      </div>
      <p class="stat-value">${esc(value)}</p>
      ${hint ? `<p class="stat-hint">${esc(hint)}</p>` : ''}
    </div>
  </a>`;
}

function alertLink(href, count, label, name) {
  const active = count > 0;
  return `<a href="${href}" data-link class="alert-link${active ? ' active' : ''}">
    ${icon(name)}
    <span class="label-text">${esc(label)}</span>
    <span class="badge ${active ? 'badge-saffron' : 'badge-secondary'}" aria-label="${count} ${esc(label.toLowerCase())}">${count}</span>
    ${icon('ArrowRight', 'arrow')}
  </a>`;
}

function paymentBadge(status, overdue) {
  if (status === 'CANCELLED') return '<span class="badge badge-outline">Cancelled</span>';
  if (status === 'PAID') return '<span class="badge badge-success">Paid</span>';
  return `<span class="badges">
    <span class="badge ${status === 'PARTIAL' ? 'badge-warning' : 'badge-secondary'}">${status === 'PARTIAL' ? 'Part paid' : 'Unpaid'}</span>
    ${overdue ? '<span class="badge badge-danger">Overdue</span>' : ''}
  </span>`;
}

function errorState(message) {
  return `<div class="card" role="alert" style="align-items: center; gap: 0.75rem; padding-block: 2.5rem; text-align: center">
    <span class="icon-circle danger">${icon('AlertTriangle', 'size-6')}</span>
    <p class="card-title" style="font-size: 1.125rem; line-height: 1.75rem">Could not load the dashboard</p>
    <p class="muted" style="max-width: 28rem; font-size: 0.875rem">${esc(message)}</p>
    <button type="button" class="btn btn-primary" id="dash-retry">${icon('RotateCw')} Try again</button>
  </div>`;
}

function skeleton() {
  const block = (style) => `<div class="skeleton" style="${style}"></div>`;
  const statSkel = `<div class="card" style="gap: 0.75rem; padding: 1rem 1.25rem">${block('height: 1rem; width: 8rem')}${block('height: 1.75rem; width: 10rem')}${block('height: 1rem; width: 6rem')}</div>`;
  return `<div style="display: grid; gap: 1.5rem" aria-busy="true" aria-label="Loading dashboard">
    <div class="grid-stats">${statSkel.repeat(6)}</div>
    <div class="grid-alerts">${block('height: 3.5rem; border-radius: 0.875rem').repeat(2)}</div>
    <div class="grid-split">
      <div class="span-3">${block('height: 20rem; border-radius: 0.875rem')}</div>
      <div class="span-2">${block('height: 20rem; border-radius: 0.875rem')}</div>
    </div>
    ${block('height: 18rem; border-radius: 0.875rem')}
  </div>`;
}

// ─── Sales chart ────────────────────────────────────────────────────────────

/** Sales for the last 7 days, labelled with BS dates (AD in the tooltip). */
function chartFigure(days) {
  const week = days.reduce((s, d) => s + toNumber(d.total), 0);
  return `<figure style="width: 100%">
    <figcaption class="sr-only">Sales in the last 7 days: ${esc(
      days.map((d) => `${isoToBS(d.date)} ${formatNPR(d.total)}`).join('; '),
    )}. Total ${esc(formatNPR(week.toFixed(2)))}.</figcaption>
    <div class="chart" id="sales-chart" aria-hidden="true"></div>
  </figure>`;
}

/** Round axis maximum and step, e.g. 0–48,000 in steps of 12,000. */
function niceScale(max, ticks = 4) {
  if (max <= 0) return { top: 4, step: 1 };
  const rough = max / ticks;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rough);
  return { top: step * Math.ceil(max / step), step };
}

/** Draws the bar chart and keeps it sized to its box; returns a cleanup function. */
function drawChart(box, days) {
  if (!box) return null;
  const points = days.map((d) => ({
    date: d.date,
    label: isoToBSShort(d.date),
    total: toNumber(d.total),
    raw: d.total,
  }));
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;

  const render = () => {
    const width = box.clientWidth;
    const height = box.clientHeight;
    if (!width || !height) return;
    const m = { top: 8, right: 8, bottom: 30, left: 48 };
    const plotW = width - m.left - m.right;
    const plotH = height - m.top - m.bottom;
    const { top, step } = niceScale(Math.max(...points.map((p) => p.total)));
    const band = plotW / points.length;
    const barW = Math.min(44, band * 0.8);
    const y = (v) => m.top + plotH - (v / top) * plotH;

    let svg = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`;
    for (let v = 0; v <= top + step / 2; v += step) {
      svg += `<line class="grid-line" x1="${m.left}" x2="${width - m.right}" y1="${y(v)}" y2="${y(v)}"/>`;
      svg += `<text class="tick" x="${m.left - 8}" y="${y(v)}" text-anchor="end" dominant-baseline="middle">${compactNPR(v)}</text>`;
    }
    points.forEach((p, i) => {
      const cx = m.left + band * i + band / 2;
      const h = Math.max(0, m.top + plotH - y(p.total));
      const bx = cx - barW / 2;
      const by = m.top + plotH - h;
      const r = Math.min(4, h, barW / 2);
      svg += `<rect class="hover-col" data-i="${i}" x="${m.left + band * i}" y="${m.top}" width="${band}" height="${plotH}"/>`;
      if (h > 0) {
        svg += `<path class="bar${i === points.length - 1 ? ' today' : ''}" d="M${bx},${by + h} V${by + r} Q${bx},${by} ${bx + r},${by} H${bx + barW - r} Q${bx + barW},${by} ${bx + barW},${by + r} V${by + h} Z"/>`;
      }
      svg += `<text class="tick" x="${cx}" y="${height - m.bottom + 18}" text-anchor="middle">${esc(p.label)}</text>`;
    });
    svg += '</svg>';
    box.innerHTML = svg;
    box.append(tip);

    const cols = box.querySelectorAll('.hover-col');
    const show = (i) => {
      cols.forEach((c, j) => c.classList.toggle('on', j === i));
      const p = points[i];
      tip.innerHTML = `<p class="font-medium nepali">${esc(isoToBS(p.date))} BS</p>
        <p class="muted" style="font-size: 0.75rem">${esc(formatAD(p.date))}</p>
        <p class="amount">${esc(formatNPR(p.raw))}</p>`;
      tip.style.left = `${m.left + band * i + band / 2}px`;
      tip.style.top = `${Math.max(y(p.total), m.top + 40)}px`;
      tip.hidden = false;
    };
    const hide = () => {
      cols.forEach((c) => c.classList.remove('on'));
      tip.hidden = true;
    };
    cols.forEach((c) => c.addEventListener('mouseenter', () => show(Number(c.dataset.i))));
    box.querySelector('svg').addEventListener('mouseleave', hide);
  };

  const observer = new ResizeObserver(render);
  observer.observe(box);
  render();
  return () => observer.disconnect();
}
