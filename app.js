// ============================================================
// DriveWise — Calculation Engine + UI Controller
// ============================================================

// ------------------------------------------------------------
// MATH HELPERS
// ------------------------------------------------------------

/** Future value of a lump sum: PV × (1 + r)^n */
function fv(pv, annualPct, years) {
  return pv * Math.pow(1 + annualPct / 100, years);
}

/**
 * Monthly payment: P × r × (1+r)^n / ((1+r)^n − 1)
 */
function calcMonthlyPayment(principal, annualPct, termMonths) {
  if (annualPct === 0) return principal / termMonths;
  const r = annualPct / 100 / 12;
  const factor = Math.pow(1 + r, termMonths);
  return (principal * r * factor) / (factor - 1);
}

/**
 * Outstanding balance after k payments:
 * B(k) = P × ((1+r)^n − (1+r)^k) / ((1+r)^n − 1)
 */
function loanBalance(principal, annualPct, termMonths, elapsed) {
  if (annualPct === 0) return principal * (1 - elapsed / termMonths);
  const r = annualPct / 100 / 12;
  const nF = Math.pow(1 + r, termMonths);
  const kF = Math.pow(1 + r, elapsed);
  return principal * (nF - kF) / (nF - 1);
}

/**
 * Sum of an annually-inflating cost over N years:
 * = base × ((1+g)^n − 1) / g
 */
function sumInflated(annualBase, cpiPct, years) {
  if (cpiPct === 0 || annualBase === 0) return annualBase * years;
  const g = cpiPct / 100;
  return annualBase * (Math.pow(1 + g, years) - 1) / g;
}

/**
 * Build a per-year amortization schedule.
 * Returns array of { year, startBalance, annualPayment, principalPaid, interestPaid, endBalance }.
 */
function buildAmortSchedule(principal, annualPct, termMonths) {
  if (principal <= 0 || termMonths <= 0) return [];
  const r   = annualPct > 0 ? annualPct / 100 / 12 : 0;
  const pmt = calcMonthlyPayment(principal, annualPct, termMonths);
  const totalYears = Math.ceil(termMonths / 12);
  const rows = [];
  let balance = principal;

  for (let y = 1; y <= totalYears; y++) {
    const startBalance   = balance;
    const monthsThisYear = Math.min(12, termMonths - (y - 1) * 12);
    let principalPaid = 0, interestPaid = 0;

    for (let m = 0; m < monthsThisYear; m++) {
      const intCharge  = balance * r;
      const prinCharge = pmt - intCharge;
      interestPaid  += intCharge;
      principalPaid += prinCharge;
      balance = Math.max(0, balance - prinCharge);
    }

    rows.push({ year: y, startBalance, annualPayment: pmt * monthsThisYear, principalPaid, interestPaid, endBalance: balance });
    if (balance < 0.01) break;
  }
  return rows;
}

// ------------------------------------------------------------
// FORMAT HELPERS
// ------------------------------------------------------------

function fmt$(n) {
  const abs = Math.abs(n);
  const str = abs.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return (n < 0 ? '-$' : '$') + str;
}

function fmt$dec(n) {
  return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ------------------------------------------------------------
// COLOR PALETTES FOR DYNAMIC OPTIONS
// ------------------------------------------------------------

const FIN_COLORS   = ['#f59e0b', '#f97316', '#ef4444', '#e11d48'];
const LEASE_COLORS = ['#8b5cf6', '#a855f7', '#3b82f6', '#06b6d4'];

// ------------------------------------------------------------
// DYNAMIC OPTION STATE
// ------------------------------------------------------------

let financeOptions = [
  { id: 1, name: 'Finance 6.5% / 60mo', downPayment: 5000, loanAPR: 6.5, loanTermMonths: 60 }
];
let leaseOptions = [
  { id: 1, name: 'Lease $549/mo 36mo', leaseMonthly: 549, dueAtSigning: 3500, leaseTermMonths: 36, leaseEndFee: 395, excessMileage: 1200 }
];
let nextFinId   = 2;
let nextLeaseId = 2;

// ------------------------------------------------------------
// PER-OPTION CALCULATION HELPERS
// ------------------------------------------------------------

function calcCashNew(inp, shared, hMonths, miles) {
  const purchase  = inp.newCarPrice * (1 + inp.salesTax / 100) + inp.fees;
  const maintInfl = sumInflated(inp.maintenanceNew, inp.cpiRate, inp.horizonYears);
  const ongoing   = shared + maintInfl;
  const oop       = purchase + ongoing;
  const invest    = fv(inp.cashAvailable - purchase, inp.investReturn, inp.horizonYears);
  return {
    key: 'cashNew', label: 'Pay Cash — New', shortLabel: 'Cash (New)', color: '#6366f1', type: 'cash',
    upfrontCost: purchase, totalOngoing: ongoing, runningCosts: ongoing, loanLeasePaid: 0,
    totalOOP: oop, totalInterest: 0, monthlyPayment: null, investmentAtEnd: invest,
    resaleValue: inp.newCarResale, outstandingDebt: 0,
    netPosition: invest + inp.newCarResale - ongoing,
    monthlyEquiv: oop / hMonths, costPerMile: oop / miles,
  };
}

function calcCashUsed(inp, shared, hMonths, miles) {
  const purchase  = inp.usedCarPrice * (1 + inp.salesTax / 100) + inp.fees;
  const maintInfl = sumInflated(inp.maintenanceUsed, inp.cpiRate, inp.horizonYears);
  const ongoing   = shared + maintInfl;
  const oop       = purchase + ongoing;
  const invest    = fv(inp.cashAvailable - purchase, inp.investReturn, inp.horizonYears);
  return {
    key: 'cashUsed', label: 'Cash — Used', shortLabel: 'Cash (Used)', color: '#10b981', type: 'cash',
    upfrontCost: purchase, totalOngoing: ongoing, runningCosts: ongoing, loanLeasePaid: 0,
    totalOOP: oop, totalInterest: 0, monthlyPayment: null, investmentAtEnd: invest,
    resaleValue: inp.usedCarResale, outstandingDebt: 0,
    netPosition: invest + inp.usedCarResale - ongoing,
    monthlyEquiv: oop / hMonths, costPerMile: oop / miles,
  };
}

function calcFinanceOption(inp, opt, color, shared, hMonths, miles) {
  const taxFees     = inp.newCarPrice * (inp.salesTax / 100) + inp.fees;
  const upfront     = opt.downPayment + taxFees;
  const principal   = Math.max(0, inp.newCarPrice - opt.downPayment);
  const monthly     = calcMonthlyPayment(principal, opt.loanAPR, opt.loanTermMonths);
  const payMonths   = Math.min(hMonths, opt.loanTermMonths);
  const loanPaid    = monthly * payMonths;
  const interest    = monthly * opt.loanTermMonths - principal; // full-term interest
  const maintInfl   = sumInflated(inp.maintenanceNew, inp.cpiRate, inp.horizonYears);
  const ongoing     = shared + maintInfl;
  const oop         = upfront + loanPaid + ongoing;
  const invest      = fv(inp.cashAvailable - upfront, inp.investReturn, inp.horizonYears);
  const outstanding = hMonths < opt.loanTermMonths
    ? loanBalance(principal, opt.loanAPR, opt.loanTermMonths, hMonths)
    : 0;
  return {
    key: `fin_${opt.id}`, label: opt.name, shortLabel: opt.name, color, type: 'finance',
    upfrontCost: upfront, totalOngoing: ongoing, runningCosts: ongoing, loanLeasePaid: loanPaid,
    totalOOP: oop, totalInterest: interest, monthlyPayment: monthly, investmentAtEnd: invest,
    resaleValue: inp.newCarResale, outstandingDebt: outstanding,
    netPosition: invest + inp.newCarResale - loanPaid - ongoing - outstanding,
    monthlyEquiv: oop / hMonths, costPerMile: oop / miles,
    _amort: { principal, apr: opt.loanAPR, termMonths: opt.loanTermMonths, horizonYears: inp.horizonYears },
  };
}

function calcLeaseOption(inp, opt, color, shared, hMonths, miles) {
  const cycles      = Math.ceil(hMonths / opt.leaseTermMonths);
  const payments    = opt.leaseMonthly * hMonths;
  const endFeeTotal = opt.leaseEndFee * cycles;
  const upfront     = opt.dueAtSigning;
  const ongoing     = payments + (cycles - 1) * opt.dueAtSigning + endFeeTotal + opt.excessMileage + shared;
  const oop         = upfront + ongoing;
  const invest      = fv(inp.cashAvailable - upfront, inp.investReturn, inp.horizonYears);
  return {
    key: `lease_${opt.id}`, label: opt.name, shortLabel: opt.name, color, type: 'lease',
    upfrontCost: upfront, totalOngoing: ongoing, runningCosts: shared,
    loanLeasePaid: payments + endFeeTotal + opt.excessMileage + (cycles - 1) * opt.dueAtSigning,
    totalOOP: oop, totalInterest: 0, monthlyPayment: opt.leaseMonthly, investmentAtEnd: invest,
    resaleValue: 0, outstandingDebt: 0,
    netPosition: invest - ongoing,
    monthlyEquiv: oop / hMonths, costPerMile: oop / miles,
    leaseCycles: cycles,
  };
}

// ------------------------------------------------------------
// MAIN CALCULATE — returns array of results
// ------------------------------------------------------------

function calculateAll(inp) {
  const hMonths = inp.horizonYears * 12;
  const miles   = inp.annualMiles * inp.horizonYears;
  const shared  = sumInflated(inp.insurancePerYear + inp.registrationPerYear, inp.cpiRate, inp.horizonYears);

  return [
    calcCashNew(inp, shared, hMonths, miles),
    calcCashUsed(inp, shared, hMonths, miles),
    ...financeOptions.map((opt, i) => calcFinanceOption(inp, opt, FIN_COLORS[i % FIN_COLORS.length], shared, hMonths, miles)),
    ...leaseOptions.map((opt, i)   => calcLeaseOption(inp, opt, LEASE_COLORS[i % LEASE_COLORS.length], shared, hMonths, miles)),
  ];
}

// ------------------------------------------------------------
// READ SHARED INPUTS FROM DOM
// ------------------------------------------------------------

function getInputs() {
  const g = id => { const el = document.getElementById(id); return el ? (parseFloat(el.value) || 0) : 0; };
  return {
    newCarPrice:         g('newCarPrice'),
    usedCarPrice:        g('usedCarPrice'),
    salesTax:            g('salesTax'),
    fees:                g('fees'),
    horizonYears:        Math.max(1, g('horizonYears')),
    annualMiles:         Math.max(1, g('annualMiles')),
    cashAvailable:       g('cashAvailable'),
    newCarResale:        g('newCarResale'),
    usedCarResale:       g('usedCarResale'),
    insurancePerYear:    g('insurancePerYear'),
    maintenanceNew:      g('maintenanceNew'),
    maintenanceUsed:     g('maintenanceUsed'),
    registrationPerYear: g('registrationPerYear'),
    investReturn:        g('investReturn'),
    cpiRate:             g('cpiRate'),
  };
}

// ------------------------------------------------------------
// RENDER DYNAMIC FINANCE INPUT CARDS
// ------------------------------------------------------------

function renderFinanceInputs() {
  const c = document.getElementById('finOptionsContainer');
  if (!c) return;
  c.innerHTML = financeOptions.map((opt, idx) => {
    const color     = FIN_COLORS[idx % FIN_COLORS.length];
    const canRemove = financeOptions.length > 1;
    return `
      <div class="dyn-opt-card" style="border-left: 3px solid ${color}">
        <div class="dyn-opt-header">
          <span class="dyn-opt-dot" style="background:${color}"></span>
          <input class="opt-name-input" type="text" value="${opt.name}"
                 oninput="updateFinOpt(${opt.id},'name',this.value);update()" />
          ${canRemove ? `<button class="remove-opt-btn" onclick="removeFinOpt(${opt.id})">&#x2715;</button>` : ''}
        </div>
        <div class="input-grid">
          <div class="field">
            <label>Down Payment</label>
            <div class="input-wrap has-pre"><span class="pre">$</span>
              <input type="number" value="${opt.downPayment}"
                     oninput="updateFinOpt(${opt.id},'downPayment',+this.value);update()" />
            </div>
          </div>
          <div class="field">
            <label>Loan APR</label>
            <div class="input-wrap has-suf"><span class="suf">%</span>
              <input type="number" value="${opt.loanAPR}" step="0.1"
                     oninput="updateFinOpt(${opt.id},'loanAPR',+this.value);update()" />
            </div>
          </div>
          <div class="field span-2">
            <label>Loan Term <span class="tip" data-tip="Common: 48, 60, 72, or 84 months">?</span></label>
            <div class="input-wrap has-suf"><span class="suf">mo</span>
              <input type="number" value="${opt.loanTermMonths}"
                     oninput="updateFinOpt(${opt.id},'loanTermMonths',+this.value);update()" />
            </div>
          </div>
        </div>
      </div>`;
  }).join('');
}

function renderLeaseInputs() {
  const c = document.getElementById('leaseOptionsContainer');
  if (!c) return;
  c.innerHTML = leaseOptions.map((opt, idx) => {
    const color     = LEASE_COLORS[idx % LEASE_COLORS.length];
    const canRemove = leaseOptions.length > 1;
    return `
      <div class="dyn-opt-card" style="border-left: 3px solid ${color}">
        <div class="dyn-opt-header">
          <span class="dyn-opt-dot" style="background:${color}"></span>
          <input class="opt-name-input" type="text" value="${opt.name}"
                 oninput="updateLeaseOpt(${opt.id},'name',this.value);update()" />
          ${canRemove ? `<button class="remove-opt-btn" onclick="removeLeaseOpt(${opt.id})">&#x2715;</button>` : ''}
        </div>
        <div class="input-grid">
          <div class="field">
            <label>Monthly Payment</label>
            <div class="input-wrap has-pre"><span class="pre">$</span>
              <input type="number" value="${opt.leaseMonthly}"
                     oninput="updateLeaseOpt(${opt.id},'leaseMonthly',+this.value);update()" />
            </div>
          </div>
          <div class="field">
            <label>Due at Signing</label>
            <div class="input-wrap has-pre"><span class="pre">$</span>
              <input type="number" value="${opt.dueAtSigning}"
                     oninput="updateLeaseOpt(${opt.id},'dueAtSigning',+this.value);update()" />
            </div>
          </div>
          <div class="field">
            <label>Lease Term</label>
            <div class="input-wrap has-suf"><span class="suf">mo</span>
              <input type="number" value="${opt.leaseTermMonths}"
                     oninput="updateLeaseOpt(${opt.id},'leaseTermMonths',+this.value);update()" />
            </div>
          </div>
          <div class="field">
            <label>Lease-End Fee</label>
            <div class="input-wrap has-pre"><span class="pre">$</span>
              <input type="number" value="${opt.leaseEndFee}"
                     oninput="updateLeaseOpt(${opt.id},'leaseEndFee',+this.value);update()" />
            </div>
          </div>
          <div class="field span-2">
            <label>Excess Mileage / Wear <span class="tip" data-tip="Total estimated charges at lease return">?</span></label>
            <div class="input-wrap has-pre"><span class="pre">$</span>
              <input type="number" value="${opt.excessMileage}"
                     oninput="updateLeaseOpt(${opt.id},'excessMileage',+this.value);update()" />
            </div>
          </div>
        </div>
      </div>`;
  }).join('');
}

// ------------------------------------------------------------
// ADD / REMOVE / UPDATE HANDLERS
// ------------------------------------------------------------

function addFinOpt() {
  const n = financeOptions.length + 1;
  financeOptions.push({ id: nextFinId++, name: `Finance Option ${n}`, downPayment: 5000, loanAPR: 6.5, loanTermMonths: 60 });
  renderFinanceInputs();
  update();
}

function removeFinOpt(id) {
  financeOptions = financeOptions.filter(o => o.id !== id);
  renderFinanceInputs();
  update();
}

function updateFinOpt(id, field, value) {
  const opt = financeOptions.find(o => o.id === id);
  if (opt) opt[field] = field === 'name' ? value : (parseFloat(value) || 0);
}

function addLeaseOpt() {
  const n = leaseOptions.length + 1;
  leaseOptions.push({ id: nextLeaseId++, name: `Lease Option ${n}`, leaseMonthly: 499, dueAtSigning: 3000, leaseTermMonths: 36, leaseEndFee: 395, excessMileage: 1200 });
  renderLeaseInputs();
  update();
}

function removeLeaseOpt(id) {
  leaseOptions = leaseOptions.filter(o => o.id !== id);
  renderLeaseInputs();
  update();
}

function updateLeaseOpt(id, field, value) {
  const opt = leaseOptions.find(o => o.id === id);
  if (opt) opt[field] = field === 'name' ? value : (parseFloat(value) || 0);
}

// ------------------------------------------------------------
// CHART INSTANCES
// ------------------------------------------------------------

let netChart  = null;
let costChart = null;

function initCharts(results) {
  if (netChart)  { netChart.destroy();  netChart  = null; }
  if (costChart) { costChart.destroy(); costChart = null; }

  const labels    = results.map(r => r.shortLabel);
  const colors    = results.map(r => r.color);
  const netValues = results.map(r => Math.round(r.netPosition));
  const maxNet    = Math.max(...netValues);

  // ---- Chart 1: Net Position ----
  netChart = new Chart(
    document.getElementById('netPositionChart').getContext('2d'),
    {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Ending Net Position',
          data: netValues,
          backgroundColor: netValues.map((v, i) => v === maxNet ? colors[i] : colors[i] + '88'),
          borderColor: colors,
          borderWidth: 2,
          borderRadius: 6,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => ' ' + fmt$(ctx.parsed.y) } }
        },
        scales: {
          y: { ticks: { callback: v => fmt$(v), font: { size: 11 } }, grid: { color: '#f1f5f9' } },
          x: { ticks: { font: { size: 10 } }, grid: { display: false } }
        }
      }
    }
  );

  // ---- Chart 2: Cost Breakdown (stacked) ----
  costChart = new Chart(
    document.getElementById('costBreakdownChart').getContext('2d'),
    {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Upfront Cost',
            data: results.map(r => Math.round(r.upfrontCost)),
            backgroundColor: '#6366f133', borderColor: '#6366f1', borderWidth: 1,
          },
          {
            label: 'Loan / Lease Payments',
            data: results.map(r => Math.round(r.loanLeasePaid)),
            backgroundColor: '#f59e0b33', borderColor: '#f59e0b', borderWidth: 1,
          },
          {
            label: 'Insurance + Maintenance + Reg.',
            data: results.map(r => Math.round(r.runningCosts)),
            backgroundColor: '#10b98133', borderColor: '#10b981', borderWidth: 1,
          },
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { font: { size: 11 }, boxWidth: 12, padding: 12 } },
          tooltip: { callbacks: { label: ctx => ' ' + ctx.dataset.label + ': ' + fmt$(ctx.parsed.y) } }
        },
        scales: {
          x: { stacked: true, ticks: { font: { size: 10 } }, grid: { display: false } },
          y: { stacked: true, ticks: { callback: v => fmt$(v), font: { size: 11 } }, grid: { color: '#f1f5f9' } }
        }
      }
    }
  );
}

// ------------------------------------------------------------
// RENDER OPTION CARDS
// ------------------------------------------------------------

function renderOptionCards(results) {
  const bestNetIdx = results.reduce((bi, r, i) => r.netPosition > results[bi].netPosition ? i : bi, 0);
  const bestMoIdx  = results.reduce((bi, r, i) => r.monthlyEquiv < results[bi].monthlyEquiv ? i : bi, 0);

  const grid = document.getElementById('optionsGrid');
  grid.innerHTML = '';

  results.forEach((r, idx) => {
    const isBest = idx === bestNetIdx;
    let extraRows = '';
    if (r.type === 'finance') {
      extraRows += row('Monthly Loan Pmt', fmt$dec(r.monthlyPayment), 'highlight');
      extraRows += row('Total Interest (full term)', fmt$(r.totalInterest), 'negative');
    }
    if (r.type === 'lease') {
      extraRows += row('Monthly Lease Pmt', fmt$dec(r.monthlyPayment), 'highlight');
      extraRows += row('Lease Cycles', String(r.leaseCycles), '');
    }
    if (r.outstandingDebt > 0) {
      extraRows += row('Outstanding Loan at End', fmt$(r.outstandingDebt), 'negative');
    }

    const card      = document.createElement('div');
    card.className  = 'option-card' + (isBest ? ' best' : '');
    card.style.cssText = `border-top: 3px solid ${r.color};`;

    const resaleStr  = r.resaleValue > 0 ? fmt$(r.resaleValue) : '—';
    const ongoingStr = fmt$(r.totalOngoing);
    const debtStr    = r.outstandingDebt > 0 ? ` − ${fmt$(r.outstandingDebt)} debt` : '';
    const netColor   = r.netPosition >= 0 ? '#10b981' : '#ef4444';

    card.innerHTML = `
      <div class="best-badge">Best Net Position</div>
      <div class="option-tag" style="color:${r.color}">${r.label}</div>
      <div class="option-metrics">
        ${row('Monthly Equiv. Cost', fmt$dec(r.monthlyEquiv), idx === bestMoIdx ? 'positive' : '')}
        ${extraRows}
        ${row('Upfront Cost', fmt$(r.upfrontCost), '')}
        ${row('Total Out-of-Pocket', fmt$(r.totalOOP), '')}
        ${row('Cost per Mile', fmt$dec(r.costPerMile), '')}
      </div>
      <div class="net-position-row">
        <span class="net-label">Ending Net Position</span>
        <span class="net-value" style="color:${netColor}">${fmt$(r.netPosition)}</span>
      </div>
      <div class="net-breakdown">
        <span class="nb-item positive">${fmt$(r.investmentAtEnd)} invest.</span>
        <span class="nb-sep">+</span>
        <span class="nb-item ${r.resaleValue > 0 ? 'positive' : 'muted'}">${resaleStr} resale</span>
        <span class="nb-sep">−</span>
        <span class="nb-item negative">${ongoingStr} costs${debtStr}</span>
      </div>
    `;
    grid.appendChild(card);
  });
}

function row(label, value, cls) {
  return `<div class="metric-row">
    <span class="metric-label">${label}</span>
    <span class="metric-value ${cls}">${value}</span>
  </div>`;
}

// ------------------------------------------------------------
// RENDER RECOMMENDATION
// ------------------------------------------------------------

function renderRecommendation(results) {
  const bestNetIdx = results.reduce((bi, r, i) => r.netPosition > results[bi].netPosition ? i : bi, 0);
  const bestMoIdx  = results.reduce((bi, r, i) => r.monthlyEquiv < results[bi].monthlyEquiv ? i : bi, 0);
  const rNet = results[bestNetIdx];
  const rMo  = results[bestMoIdx];

  const leaseResults = results.filter(r => r.type === 'lease');
  const bestLease    = leaseResults.length > 0
    ? leaseResults.reduce((a, b) => a.monthlyEquiv < b.monthlyEquiv ? a : b)
    : null;

  document.getElementById('recGrid').innerHTML = `
    <div class="rec-item">
      <div class="rec-category">Lowest Monthly Burden</div>
      <div class="rec-winner" style="color:${rMo.color}">${rMo.label}</div>
      <div class="rec-detail">${fmt$dec(rMo.monthlyEquiv)} / mo equiv.</div>
    </div>
    <div class="rec-item">
      <div class="rec-category">Strongest Net Position</div>
      <div class="rec-winner" style="color:${rNet.color}">${rNet.label}</div>
      <div class="rec-detail">${fmt$(rNet.netPosition)} at end</div>
    </div>
    <div class="rec-item">
      <div class="rec-category">Most Flexibility</div>
      <div class="rec-winner" style="color:${bestLease ? bestLease.color : '#8b5cf6'}">${bestLease ? bestLease.label : 'Lease'}</div>
      <div class="rec-detail">No long-term ownership risk</div>
    </div>
  `;

  const inp = getInputs();
  let explanation = '';
  if (rNet.type === 'cash' && rNet.key === 'cashUsed') {
    explanation = `The used car purchase leaves you in the strongest financial position after ${inp.horizonYears} years. The lower purchase price keeps more cash invested, and smaller depreciation preserves value. Higher maintenance costs are more than offset by the cheaper upfront outlay and reduced opportunity cost drag.`;
  } else if (rNet.type === 'cash') {
    explanation = `Paying cash for the new car produces the best net position over ${inp.horizonYears} years. No interest charges and a strong resale value make it the most efficient option — particularly because your investment return (${inp.investReturn}%) is below what you'd pay in loan interest.`;
  } else if (rNet.type === 'finance') {
    explanation = `"${rNet.label}" wins because keeping more cash invested at ${inp.investReturn}% outpaces the loan interest. The spread between your investment return and loan rate is doing real work — this is the classic "borrow cheap, invest the difference" trade-off in action.`;
  } else {
    explanation = `"${rNet.label}" produces the strongest net outcome. Minimal upfront commitment keeps the most cash invested, and the compounding growth outweighs the lack of resale benefit. This typically signals favorable lease terms or a high assumed investment return.`;
  }

  document.getElementById('recExplanation').textContent = explanation;
}

// ------------------------------------------------------------
// NET POSITION BREAKDOWN TABLE
// ------------------------------------------------------------

function renderNetBreakdown(results) {
  const bestNetIdx = results.reduce((bi, r, i) => r.netPosition > results[bi].netPosition ? i : bi, 0);

  const cols = results.map((r, idx) => {
    const isBest  = idx === bestNetIdx;
    const debtStr = r.outstandingDebt > 0
      ? `<div class="nbt-row"><span>− Outstanding debt</span><span class="negative">${fmt$(r.outstandingDebt)}</span></div>`
      : '';
    return `
      <div class="nbt-col${isBest ? ' nbt-best' : ''}">
        <div class="nbt-label" style="color:${r.color}">${r.shortLabel}</div>
        <div class="nbt-row"><span>Investment at end</span><span class="positive">${fmt$(r.investmentAtEnd)}</span></div>
        <div class="nbt-row"><span>+ Resale value</span><span class="${r.resaleValue > 0 ? 'positive' : 'muted'}">${r.resaleValue > 0 ? fmt$(r.resaleValue) : '—'}</span></div>
        <div class="nbt-row"><span>− Ongoing costs</span><span class="negative">−${fmt$(r.totalOngoing)}</span></div>
        ${debtStr}
        <div class="nbt-total"><span>= Net Position</span><span style="color:${r.netPosition >= 0 ? '#10b981' : '#ef4444'}">${fmt$(r.netPosition)}</span></div>
      </div>`;
  }).join('');

  document.getElementById('netBreakdownTable').innerHTML = `<div class="nbt-grid">${cols}</div>`;
}

// ------------------------------------------------------------
// AMORTIZATION TABLE
// (shows schedule for a selected finance option; dropdown when multiple)
// ------------------------------------------------------------

let amortOpen       = false;
let selectedAmortId = null;

function toggleAmort() {
  amortOpen = !amortOpen;
  const body   = document.getElementById('amortBody');
  const toggle = document.getElementById('amortToggle');
  body.style.display = amortOpen ? 'block' : 'none';
  toggle.textContent = amortOpen ? '▲ Hide Schedule' : '▼ Show Year-by-Year Schedule';
}

function onAmortSelect(val) {
  selectedAmortId = val;
  const inp     = getInputs();
  const results = calculateAll(inp);
  renderAmortSection(results);
}

function renderAmortSection(results) {
  const finResults = results.filter(r => r.type === 'finance');
  const section    = document.getElementById('amortSection');
  if (!section) return;

  if (finResults.length === 0) { section.style.display = 'none'; return; }
  section.style.display = 'block';

  if (!selectedAmortId || !finResults.find(r => r.key === selectedAmortId)) {
    selectedAmortId = finResults[0].key;
  }

  const selected = finResults.find(r => r.key === selectedAmortId) || finResults[0];

  // Update dropdown
  const dropdown = document.getElementById('amortSelect');
  if (finResults.length > 1) {
    dropdown.style.display = 'inline-block';
    dropdown.innerHTML = finResults.map(r =>
      `<option value="${r.key}" ${r.key === selectedAmortId ? 'selected' : ''}>${r.label}</option>`
    ).join('');
  } else {
    dropdown.style.display = 'none';
  }

  renderAmortTable(selected);
}

function renderAmortTable(finResult) {
  const a        = finResult._amort;
  const schedule = buildAmortSchedule(a.principal, a.apr, a.termMonths);
  const hYears   = a.horizonYears;

  const rows = schedule.map(r => {
    const isPast         = r.year > hYears;
    const isLastInHorizon = r.year === hYears && hYears < Math.ceil(a.termMonths / 12);
    return `<tr style="${isPast ? 'opacity:0.45;' : ''}">
      <td>${r.year}${isLastInHorizon ? '<span class="amort-horizon-mark" title="Horizon ends here">← horizon end</span>' : ''}</td>
      <td>${fmt$(r.startBalance)}</td>
      <td>${fmt$(r.annualPayment)}</td>
      <td class="amort-principal">${fmt$(r.principalPaid)}</td>
      <td class="amort-interest">${fmt$(r.interestPaid)}</td>
      <td>${fmt$(r.endBalance)}</td>
    </tr>`;
  }).join('');

  const totalInterest = a.apr > 0
    ? calcMonthlyPayment(a.principal, a.apr, a.termMonths) * a.termMonths - a.principal
    : 0;

  document.getElementById('amortTableWrap').innerHTML = `
    <div class="amort-summary">
      <div class="amort-stat"><div class="amort-stat-label">Loan Principal</div><div class="amort-stat-value">${fmt$(a.principal)}</div></div>
      <div class="amort-stat"><div class="amort-stat-label">APR</div><div class="amort-stat-value">${a.apr}%</div></div>
      <div class="amort-stat"><div class="amort-stat-label">Term</div><div class="amort-stat-value">${a.termMonths} mo (${(a.termMonths/12).toFixed(1)} yrs)</div></div>
      <div class="amort-stat"><div class="amort-stat-label">Total Interest</div><div class="amort-stat-value negative">${fmt$(totalInterest)}</div></div>
      <div class="amort-stat"><div class="amort-stat-label">Monthly Payment</div><div class="amort-stat-value highlight">${fmt$dec(calcMonthlyPayment(a.principal, a.apr, a.termMonths))}</div></div>
    </div>
    <div class="amort-table-scroll">
      <table class="amort-table">
        <thead><tr>
          <th>Year</th><th>Beg. Balance</th><th>Annual Pmt</th>
          <th class="amort-principal">Principal</th><th class="amort-interest">Interest</th><th>End Balance</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="amort-note">Rows faded past Year ${hYears} are outside your comparison horizon. Early payments are interest-heavy — this is the front-loading effect.</p>
  `;
}

// ------------------------------------------------------------
// SCENARIO BUTTONS
// ------------------------------------------------------------

function setScenario(rate, btn) {
  document.getElementById('investReturn').value = rate;
  document.querySelectorAll('.scen-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  update();
}

// ------------------------------------------------------------
// MAIN UPDATE LOOP
// ------------------------------------------------------------

function update() {
  const inp     = getInputs();
  const results = calculateAll(inp);

  renderOptionCards(results);
  renderRecommendation(results);
  initCharts(results);
  renderNetBreakdown(results);
  renderAmortSection(results);
}

// ------------------------------------------------------------
// BOOT
// ------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  renderFinanceInputs();
  renderLeaseInputs();

  document.getElementById('investReturn').addEventListener('input', () => {
    const val = parseFloat(document.getElementById('investReturn').value);
    document.querySelectorAll('.scen-btn').forEach(btn => {
      btn.classList.toggle('active', parseFloat(btn.dataset.rate) === val);
    });
  });

  document.querySelectorAll('input[type="number"]').forEach(el => {
    el.addEventListener('input', update);
  });

  update();
});
