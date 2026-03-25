// ============================================================
// DriveWise — Calculation Engine + UI Controller
// ============================================================

// ------------------------------------------------------------
// MATH HELPERS
// ------------------------------------------------------------

/**
 * Future value of a lump sum (annual compounding)
 * FV = PV * (1 + r/100)^n
 */
function fv(pv, annualPct, years) {
  return pv * Math.pow(1 + annualPct / 100, years);
}

/**
 * Monthly payment via standard amortization formula
 * PMT = P * r * (1+r)^n / ((1+r)^n - 1)
 */
function calcMonthlyPayment(principal, annualPct, termMonths) {
  if (annualPct === 0) return principal / termMonths;
  const r = annualPct / 100 / 12;
  const factor = Math.pow(1 + r, termMonths);
  return (principal * r * factor) / (factor - 1);
}

/**
 * Outstanding loan balance after k payments
 * B(k) = P * ((1+r)^n - (1+r)^k) / ((1+r)^n - 1)
 */
function loanBalance(principal, annualPct, termMonths, elapsed) {
  if (annualPct === 0) return principal * (1 - elapsed / termMonths);
  const r = annualPct / 100 / 12;
  const nFactor = Math.pow(1 + r, termMonths);
  const kFactor = Math.pow(1 + r, elapsed);
  return principal * (nFactor - kFactor) / (nFactor - 1);
}

/**
 * [v2 #2] Total nominal cost of an annual expense growing at CPI over n years.
 *
 * Year 1 cost = annualBase, Year 2 = annualBase*(1+g), ... Year n = annualBase*(1+g)^(n-1)
 * Geometric series sum: base * [(1+g)^n - 1] / g  for g > 0
 *                       base * n                    for g = 0
 *
 * @param {number} annualBase  Year-1 cost
 * @param {number} cpiPct      Annual inflation rate in percent (e.g. 3 for 3%)
 * @param {number} years       Horizon in years
 */
function sumInflated(annualBase, cpiPct, years) {
  if (cpiPct === 0 || annualBase === 0) return annualBase * years;
  const g = cpiPct / 100;
  return annualBase * (Math.pow(1 + g, years) - 1) / g;
}

/**
 * [v2 #1] Build a per-year amortization schedule for a loan.
 * Returns array of { year, startBalance, annualPayment, principalPaid, interestPaid, endBalance }.
 *
 * @param {number} principal   Loan principal
 * @param {number} annualPct   Annual interest rate in percent
 * @param {number} termMonths  Loan term in months
 */
function buildAmortSchedule(principal, annualPct, termMonths) {
  if (principal <= 0 || termMonths <= 0) return [];
  const r = annualPct > 0 ? annualPct / 100 / 12 : 0;
  const pmt = calcMonthlyPayment(principal, annualPct, termMonths);
  const totalYears = Math.ceil(termMonths / 12);
  const rows = [];
  let balance = principal;

  for (let y = 1; y <= totalYears; y++) {
    const startBalance = balance;
    const monthsThisYear = Math.min(12, termMonths - (y - 1) * 12);
    let principalPaid = 0;
    let interestPaid  = 0;

    for (let m = 0; m < monthsThisYear; m++) {
      const intCharge = balance * r;
      const prinCharge = pmt - intCharge;
      interestPaid  += intCharge;
      principalPaid += prinCharge;
      balance = Math.max(0, balance - prinCharge);
    }

    rows.push({
      year:          y,
      startBalance,
      annualPayment: pmt * monthsThisYear,
      principalPaid,
      interestPaid,
      endBalance:    balance,
    });

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
// CORE CALCULATION ENGINE
// ------------------------------------------------------------

/**
 * Main calculation: returns results for all 4 options.
 *
 * Net Position = investmentAtEnd + resaleValue - totalOngoingCosts
 *
 * Where:
 *   investmentAtEnd   = fv(cashAvailable - upfrontCost, investReturn, years)
 *   upfrontCost       = lump sum at t=0 (directly reduces investable cash)
 *   totalOngoingCosts = all periodic outflows over horizon (inflated where applicable)
 *   resaleValue       = 0 for lease; estimated resale for owned cars
 *
 * [v2 #2] Ongoing costs (insurance, maintenance, registration) now escalate at cpiRate per year.
 * Loan/lease payments are fixed contracts — not inflated.
 */
function calculateAll(inp) {
  const horizonMonths = inp.horizonYears * 12;
  const totalMiles    = inp.annualMiles * inp.horizonYears;

  // Shared annual ownership costs: insurance + registration (inflated by CPI)
  const sharedInflated = sumInflated(
    inp.insurancePerYear + inp.registrationPerYear,
    inp.cpiRate,
    inp.horizonYears
  );

  // -------------------------------------------------------
  // OPTION 1: Pay Cash — New Car
  // -------------------------------------------------------
  const cashNewPurchase  = inp.newCarPrice * (1 + inp.salesTax / 100) + inp.fees;
  const cashNewMaintInfl = sumInflated(inp.maintenanceNew, inp.cpiRate, inp.horizonYears);
  const cashNewOngoing   = sharedInflated + cashNewMaintInfl;
  const cashNewOOP       = cashNewPurchase + cashNewOngoing;
  const cashNewInvest    = fv(inp.cashAvailable - cashNewPurchase, inp.investReturn, inp.horizonYears);
  const cashNewNet       = cashNewInvest + inp.newCarResale - cashNewOngoing;

  const cashNew = {
    key: 'cashNew',
    label: 'Pay Cash — New',
    shortLabel: 'Cash (New)',
    color: '#6366f1',
    upfrontCost:     cashNewPurchase,
    totalOngoing:    cashNewOngoing,
    runningCosts:    cashNewOngoing,   // ins + maint + reg only (no loans)
    loanLeasePaid:   0,
    totalOOP:        cashNewOOP,
    totalInterest:   0,
    monthlyPayment:  null,
    investmentAtEnd: cashNewInvest,
    resaleValue:     inp.newCarResale,
    outstandingDebt: 0,
    netPosition:     cashNewNet,
    monthlyEquiv:    cashNewOOP / horizonMonths,
    costPerMile:     cashNewOOP / totalMiles,
  };

  // -------------------------------------------------------
  // OPTION 2: Finance — New Car
  // -------------------------------------------------------
  const finTaxFees     = inp.newCarPrice * (inp.salesTax / 100) + inp.fees;
  const finUpfront     = inp.downPayment + finTaxFees;
  const finPrincipal   = Math.max(0, inp.newCarPrice - inp.downPayment);
  const finMonthly     = calcMonthlyPayment(finPrincipal, inp.loanAPR, inp.loanTermMonths);
  const finPayMonths   = Math.min(horizonMonths, inp.loanTermMonths);
  const finLoanPaid    = finMonthly * finPayMonths;
  const finInterest    = finMonthly * inp.loanTermMonths - finPrincipal; // full-term interest
  const finMaintInfl   = sumInflated(inp.maintenanceNew, inp.cpiRate, inp.horizonYears);
  const finOngoing     = sharedInflated + finMaintInfl;
  const finOOP         = finUpfront + finLoanPaid + finOngoing;
  const finInvest      = fv(inp.cashAvailable - finUpfront, inp.investReturn, inp.horizonYears);
  // Subtract remaining loan balance if horizon ends before payoff
  const finOutstanding = horizonMonths < inp.loanTermMonths
    ? loanBalance(finPrincipal, inp.loanAPR, inp.loanTermMonths, horizonMonths)
    : 0;
  const finNet = finInvest + inp.newCarResale - finLoanPaid - finOngoing - finOutstanding;

  const financeNew = {
    key: 'financeNew',
    label: 'Finance — New',
    shortLabel: 'Finance (New)',
    color: '#f59e0b',
    upfrontCost:     finUpfront,
    totalOngoing:    finOngoing,
    runningCosts:    finOngoing,       // ins + maint + reg only (loan is separate)
    loanLeasePaid:   finLoanPaid,
    totalOOP:        finOOP,
    totalInterest:   finInterest,
    monthlyPayment:  finMonthly,
    investmentAtEnd: finInvest,
    resaleValue:     inp.newCarResale,
    outstandingDebt: finOutstanding,
    netPosition:     finNet,
    monthlyEquiv:    finOOP / horizonMonths,
    costPerMile:     finOOP / totalMiles,
    // Amortization inputs — used by renderAmortTable
    _amort: { principal: finPrincipal, apr: inp.loanAPR, termMonths: inp.loanTermMonths, horizonYears: inp.horizonYears },
  };

  // -------------------------------------------------------
  // OPTION 3: Lease — New Car
  // -------------------------------------------------------
  const leaseCycles      = Math.ceil(horizonMonths / inp.leaseTermMonths);
  const leasePayments    = inp.leaseMonthly * horizonMonths;         // fixed contract, no inflation
  const leaseEndFeeTotal = inp.leaseEndFee * leaseCycles;
  const leaseUpfront     = inp.dueAtSigning;                         // only first signing from investment
  const leaseOngoing     = leasePayments
    + (leaseCycles - 1) * inp.dueAtSigning    // renewal signings
    + leaseEndFeeTotal
    + inp.excessMileage
    + sharedInflated;                          // insurance + reg (inflated)

  const leaseOOP    = leaseUpfront + leaseOngoing;
  const leaseInvest = fv(inp.cashAvailable - leaseUpfront, inp.investReturn, inp.horizonYears);
  const leaseNet    = leaseInvest - leaseOngoing;

  const leaseNew = {
    key: 'leaseNew',
    label: 'Lease — New',
    shortLabel: 'Lease (New)',
    color: '#8b5cf6',
    upfrontCost:     leaseUpfront,
    totalOngoing:    leaseOngoing,
    runningCosts:    sharedInflated,   // ins + reg only (lease has no separate maintenance line)
    loanLeasePaid:   leasePayments + leaseEndFeeTotal + inp.excessMileage + (leaseCycles - 1) * inp.dueAtSigning,
    totalOOP:        leaseOOP,
    totalInterest:   0,
    monthlyPayment:  inp.leaseMonthly,
    investmentAtEnd: leaseInvest,
    resaleValue:     0,
    outstandingDebt: 0,
    netPosition:     leaseNet,
    monthlyEquiv:    leaseOOP / horizonMonths,
    costPerMile:     leaseOOP / totalMiles,
    leaseCycles,
  };

  // -------------------------------------------------------
  // OPTION 4: Buy Cash — Used Car
  // -------------------------------------------------------
  const usedPurchase  = inp.usedCarPrice * (1 + inp.salesTax / 100) + inp.fees;
  const usedMaintInfl = sumInflated(inp.maintenanceUsed, inp.cpiRate, inp.horizonYears);
  const usedOngoing   = sharedInflated + usedMaintInfl;
  const usedOOP       = usedPurchase + usedOngoing;
  const usedInvest    = fv(inp.cashAvailable - usedPurchase, inp.investReturn, inp.horizonYears);
  const usedNet       = usedInvest + inp.usedCarResale - usedOngoing;

  const cashUsed = {
    key: 'cashUsed',
    label: 'Cash — Used',
    shortLabel: 'Cash (Used)',
    color: '#10b981',
    upfrontCost:     usedPurchase,
    totalOngoing:    usedOngoing,
    runningCosts:    usedOngoing,      // ins + maint + reg only (no loans)
    loanLeasePaid:   0,
    totalOOP:        usedOOP,
    totalInterest:   0,
    monthlyPayment:  null,
    investmentAtEnd: usedInvest,
    resaleValue:     inp.usedCarResale,
    outstandingDebt: 0,
    netPosition:     usedNet,
    monthlyEquiv:    usedOOP / horizonMonths,
    costPerMile:     usedOOP / totalMiles,
  };

  return { cashNew, financeNew, leaseNew, cashUsed };
}

// ------------------------------------------------------------
// READ INPUTS FROM DOM
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
    downPayment:         g('downPayment'),
    loanAPR:             g('loanAPR'),
    loanTermMonths:      Math.max(1, g('loanTermMonths')),
    leaseMonthly:        g('leaseMonthly'),
    dueAtSigning:        g('dueAtSigning'),
    leaseTermMonths:     Math.max(1, g('leaseTermMonths')),
    leaseEndFee:         g('leaseEndFee'),
    excessMileage:       g('excessMileage'),
    insurancePerYear:    g('insurancePerYear'),
    maintenanceNew:      g('maintenanceNew'),
    maintenanceUsed:     g('maintenanceUsed'),
    registrationPerYear: g('registrationPerYear'),
    investReturn:        g('investReturn'),
    cpiRate:             g('cpiRate'),   // [v2 #2] inflation rate for ongoing costs
  };
}

// ------------------------------------------------------------
// CHART INSTANCES
// ------------------------------------------------------------
let netChart  = null;
let costChart = null;

function initCharts(results) {
  const opts = ['cashNew', 'financeNew', 'leaseNew', 'cashUsed'];

  if (netChart)  { netChart.destroy();  netChart  = null; }
  if (costChart) { costChart.destroy(); costChart = null; }

  const labels    = opts.map(k => results[k].shortLabel);
  const colors    = opts.map(k => results[k].color);
  const netValues = opts.map(k => Math.round(results[k].netPosition));
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
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => ' ' + fmt$(ctx.parsed.y) } }
        },
        scales: {
          y: {
            ticks: { callback: v => fmt$(v), font: { size: 11 } },
            grid: { color: '#f1f5f9' }
          },
          x: {
            ticks: { font: { size: 11 } },
            grid: { display: false }
          }
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
            data: opts.map(k => Math.round(results[k].upfrontCost)),
            backgroundColor: '#6366f133',
            borderColor: '#6366f1',
            borderWidth: 1,
          },
          {
            label: 'Loan / Lease Payments',
            data: opts.map(k => Math.round(results[k].loanLeasePaid)),
            backgroundColor: '#f59e0b33',
            borderColor: '#f59e0b',
            borderWidth: 1,
          },
          {
            label: 'Insurance + Maintenance + Reg. (inflation-adj.)',
            data: opts.map(k => Math.round(results[k].runningCosts)),
            backgroundColor: '#10b98133',
            borderColor: '#10b981',
            borderWidth: 1,
          },
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: { font: { size: 11 }, boxWidth: 12, padding: 12 }
          },
          tooltip: {
            callbacks: {
              label: ctx => ' ' + ctx.dataset.label + ': ' + fmt$(ctx.parsed.y)
            }
          }
        },
        scales: {
          x: { stacked: true, ticks: { font: { size: 11 } }, grid: { display: false } },
          y: {
            stacked: true,
            ticks: { callback: v => fmt$(v), font: { size: 11 } },
            grid: { color: '#f1f5f9' }
          }
        }
      }
    }
  );
}

// ------------------------------------------------------------
// RENDER OPTION CARDS
// ------------------------------------------------------------

function renderOptionCards(results) {
  const opts        = ['cashNew', 'financeNew', 'leaseNew', 'cashUsed'];
  const bestNetKey  = opts.reduce((a, b) => results[a].netPosition > results[b].netPosition ? a : b);
  const bestMoKey   = opts.reduce((a, b) => results[a].monthlyEquiv < results[b].monthlyEquiv ? a : b);

  const grid = document.getElementById('optionsGrid');
  grid.innerHTML = '';

  opts.forEach(key => {
    const r     = results[key];
    const isBest = key === bestNetKey;

    let extraRows = '';
    if (key === 'financeNew') {
      extraRows += row('Monthly Loan Pmt', fmt$dec(r.monthlyPayment), 'highlight');
      extraRows += row('Total Interest (full term)', fmt$(r.totalInterest), 'negative');
    }
    if (key === 'leaseNew') {
      extraRows += row('Monthly Lease Pmt', fmt$dec(r.monthlyPayment), 'highlight');
      extraRows += row('Lease Cycles', r.leaseCycles + ' × ' + document.getElementById('leaseTermMonths').value + ' mo', '');
    }
    if (r.outstandingDebt > 0) {
      extraRows += row('Outstanding Loan at End', fmt$(r.outstandingDebt), 'negative');
    }

    const card = document.createElement('div');
    card.className = 'option-card' + (isBest ? ' best' : '');
    card.style.cssText = `border-top: 3px solid ${r.color};`;
    const resaleStr   = r.resaleValue > 0 ? fmt$(r.resaleValue) : '—';
    const ongoingStr  = fmt$(r.totalOngoing);
    const debtStr     = r.outstandingDebt > 0 ? ` − ${fmt$(r.outstandingDebt)} debt` : '';
    const netColor    = r.netPosition >= 0 ? '#10b981' : '#ef4444';

    card.innerHTML = `
      <div class="best-badge">Best Net Position</div>
      <div class="option-tag" style="color:${r.color}">${r.label}</div>
      <div class="option-metrics">
        ${row('Monthly Equiv. Cost', fmt$dec(r.monthlyEquiv), key === bestMoKey ? 'positive' : '')}
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
  const opts       = ['cashNew', 'financeNew', 'leaseNew', 'cashUsed'];
  const bestNetKey = opts.reduce((a, b) => results[a].netPosition > results[b].netPosition ? a : b);
  const bestMoKey  = opts.reduce((a, b) => results[a].monthlyEquiv < results[b].monthlyEquiv ? a : b);
  const rNet = results[bestNetKey];
  const rMo  = results[bestMoKey];

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
      <div class="rec-winner" style="color:${results.leaseNew.color}">Lease — New</div>
      <div class="rec-detail">No long-term ownership risk</div>
    </div>
  `;

  const inp = getInputs();
  let explanation = '';
  if (bestNetKey === 'cashUsed') {
    explanation = `The used car purchase leaves you in the strongest financial position after ${inp.horizonYears} years. The lower purchase price keeps more cash invested, and the smaller depreciation hit preserves value. Higher maintenance costs are more than offset by the cheaper upfront outlay and reduced opportunity cost drag.`;
  } else if (bestNetKey === 'cashNew') {
    explanation = `Paying cash for the new car produces the best net position over ${inp.horizonYears} years. No interest charges and a strong resale value make it the most efficient option here — particularly because your investment return (${inp.investReturn}%) is below the loan rate you'd pay if financing.`;
  } else if (bestNetKey === 'financeNew') {
    explanation = `Financing the new car wins because keeping more cash invested at ${inp.investReturn}% outpaces the ${inp.loanAPR}% loan interest. The spread between your investment return and loan rate is doing real work — this is the classic "borrow cheap, invest the difference" trade-off in action.`;
  } else {
    explanation = `Leasing produces the strongest net outcome over ${inp.horizonYears} years. Minimal upfront commitment keeps the most cash invested, and the compounding growth outweighs the lack of a resale benefit and the higher total outflows. This typically signals unusually favorable lease terms or a high investment return assumption.`;
  }

  document.getElementById('recExplanation').textContent = explanation;
}

// ------------------------------------------------------------
// NET POSITION BREAKDOWN TABLE (below bar chart)
// ------------------------------------------------------------

function renderNetBreakdown(results) {
  const opts = ['cashNew', 'financeNew', 'leaseNew', 'cashUsed'];
  const bestNetKey = opts.reduce((a, b) => results[a].netPosition > results[b].netPosition ? a : b);

  const cols = opts.map(k => {
    const r = results[k];
    const isBest = k === bestNetKey;
    const debtStr = r.outstandingDebt > 0 ? `<div class="nbt-row"><span>− Outstanding debt</span><span class="negative">${fmt$(r.outstandingDebt)}</span></div>` : '';
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
// [v2 #1] AMORTIZATION SCHEDULE TABLE
// ------------------------------------------------------------

let amortOpen = false;

function toggleAmort() {
  amortOpen = !amortOpen;
  const body   = document.getElementById('amortBody');
  const toggle = document.getElementById('amortToggle');
  body.style.display   = amortOpen ? 'block' : 'none';
  toggle.textContent   = amortOpen ? '▲ Hide Schedule' : '▼ Show Year-by-Year Schedule';
}

function renderAmortTable(finResult) {
  const a = finResult._amort;
  const schedule = buildAmortSchedule(a.principal, a.apr, a.termMonths);

  const horizonYears = a.horizonYears;
  let totalPrincipal = 0, totalInterest = 0, totalPayments = 0;

  const rows = schedule.map(r => {
    totalPrincipal += r.principalPaid;
    totalInterest  += r.interestPaid;
    totalPayments  += r.annualPayment;

    const isPastHorizon = r.year > horizonYears;
    const isLastInHorizon = r.year === horizonYears && horizonYears < Math.ceil(a.termMonths / 12);
    const rowStyle = isPastHorizon ? 'opacity:0.45;' : '';
    const horizonMarker = isLastInHorizon
      ? '<span class="amort-horizon-mark" title="Horizon ends here">← horizon end</span>'
      : '';

    return `<tr style="${rowStyle}">
      <td>${r.year}${horizonMarker}</td>
      <td>${fmt$(r.startBalance)}</td>
      <td>${fmt$(r.annualPayment)}</td>
      <td class="amort-principal">${fmt$(r.principalPaid)}</td>
      <td class="amort-interest">${fmt$(r.interestPaid)}</td>
      <td>${fmt$(r.endBalance)}</td>
    </tr>`;
  }).join('');

  const loanTermYears = (a.termMonths / 12).toFixed(1);
  const totalInterestFormatted = fmt$(a.apr > 0 ? (calcMonthlyPayment(a.principal, a.apr, a.termMonths) * a.termMonths - a.principal) : 0);

  document.getElementById('amortTableWrap').innerHTML = `
    <div class="amort-summary">
      <div class="amort-stat">
        <div class="amort-stat-label">Loan Principal</div>
        <div class="amort-stat-value">${fmt$(a.principal)}</div>
      </div>
      <div class="amort-stat">
        <div class="amort-stat-label">APR</div>
        <div class="amort-stat-value">${a.apr}%</div>
      </div>
      <div class="amort-stat">
        <div class="amort-stat-label">Term</div>
        <div class="amort-stat-value">${a.termMonths} mo (${loanTermYears} yrs)</div>
      </div>
      <div class="amort-stat">
        <div class="amort-stat-label">Total Interest</div>
        <div class="amort-stat-value negative">${totalInterestFormatted}</div>
      </div>
      <div class="amort-stat">
        <div class="amort-stat-label">Monthly Payment</div>
        <div class="amort-stat-value highlight">${fmt$dec(calcMonthlyPayment(a.principal, a.apr, a.termMonths))}</div>
      </div>
    </div>
    <div class="amort-table-scroll">
      <table class="amort-table">
        <thead>
          <tr>
            <th>Year</th>
            <th>Beg. Balance</th>
            <th>Annual Pmt</th>
            <th class="amort-principal">Principal</th>
            <th class="amort-interest">Interest</th>
            <th>End Balance</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="amort-note">
      Rows faded past Year ${horizonYears} are outside your comparison horizon.
      Front-loaded interest: more interest is paid in early years — the table makes this visible.
    </p>
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
  renderAmortTable(results.financeNew);  // [v2 #1]
}

// ------------------------------------------------------------
// BOOT
// ------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  // Sync scenario buttons with investReturn field
  document.getElementById('investReturn').addEventListener('input', () => {
    const val = parseFloat(document.getElementById('investReturn').value);
    document.querySelectorAll('.scen-btn').forEach(btn => {
      btn.classList.toggle('active', parseFloat(btn.dataset.rate) === val);
    });
  });

  // Live update on all number inputs
  document.querySelectorAll('input[type="number"]').forEach(el => {
    el.addEventListener('input', update);
  });

  update();
});
