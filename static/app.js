/* CashFlow SPA — vanilla JS. All slider math is client-side; persistence is
   debounced to the API so dragging never waits on the network. */

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

let state = null; // { settings, scenarios, active }

const fmt$ = (n, dec = 0) =>
  (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: dec, minimumFractionDigits: dec });
const fmtPct = (n) => n.toFixed(1).replace(/\.0$/, "") + "%";

// ---------- api ----------

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || res.statusText);
  }
  return res.json();
}

const debouncers = {};
function debounce(key, fn, ms = 400) {
  clearTimeout(debouncers[key]);
  debouncers[key] = setTimeout(fn, ms);
}

function toast(msg, ms = 2200) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}

// ---------- derived numbers ----------

function grossAnnual() {
  return state.active.income_streams.reduce((s, x) => s + x.annual_gross, 0);
}

function netAnnual() {
  const def = parseFloat(state.settings.default_tax_rate) || 0;
  return state.active.income_streams.reduce((s, x) => {
    const rate = x.tax_rate == null ? def : x.tax_rate;
    return s + x.annual_gross * (1 - rate / 100);
  }, 0);
}

function catAnnual(cat) {
  return netAnnual() * cat.pct / 100;
}

function monthsToGoal(cat) {
  if (cat.target_amount == null) return null;
  const remaining = cat.target_amount - cat.current_balance;
  if (remaining <= 0) return 0;
  const perMonth = catAnnual(cat) / 12;
  if (perMonth <= 0) return Infinity;
  return remaining / perMonth;
}

function etaLabel(months) {
  if (months === null) return "";
  if (months === 0) return "✓ funded";
  if (!isFinite(months)) return "never at 0%";
  const d = new Date();
  d.setMonth(d.getMonth() + Math.ceil(months));
  const when = d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
  const yrs = months / 12;
  const dur = yrs >= 1 ? `${yrs.toFixed(1)} yr` : `${Math.ceil(months)} mo`;
  return `${when} · ${dur}`;
}

// ---------- rebalancing ----------
// Move category `id` to `newPct`; unlocked others absorb the difference
// proportionally to their current share. Locked cats never move.

function rebalance(cats, id, newPct) {
  const target = cats.find((c) => c.id === id);
  const others = cats.filter((c) => c.id !== id && !c.locked);
  const lockedSum = cats.filter((c) => c.id !== id && c.locked).reduce((s, c) => s + c.pct, 0);

  newPct = Math.min(Math.max(newPct, 0), Math.max(0, 100 - lockedSum));
  const room = 100 - lockedSum - newPct; // what the unlocked others must sum to
  const otherSum = others.reduce((s, c) => s + c.pct, 0);

  others.forEach((c) => {
    c.pct = otherSum > 0 ? (c.pct / otherSum) * room : room / (others.length || 1);
  });
  target.pct = newPct;

  // absorb float drift into the largest unlocked other (or the target)
  const drift = 100 - cats.reduce((s, c) => s + c.pct, 0);
  if (Math.abs(drift) > 1e-9) {
    const sink = others.sort((a, b) => b.pct - a.pct)[0] || target;
    sink.pct = Math.max(0, sink.pct + drift);
  }
}

// ---------- rendering ----------

function render() {
  renderScenarioBar();
  renderIncome();
  renderCategories();
  renderGoals();
}

function renderScenarioBar() {
  const sel = $("#scenario-select");
  sel.innerHTML = state.scenarios
    .map((s) => `<option value="${s.id}" ${s.id === state.active.id ? "selected" : ""}>${esc(s.name)}</option>`)
    .join("");
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function renderIncome() {
  const box = $("#streams");
  box.innerHTML = "";
  for (const st of state.active.income_streams) {
    const div = document.createElement("div");
    div.className = "stream";
    div.innerHTML = `
      <div class="stream-head">
        <input class="name" value="${esc(st.name)}">
        <span class="amount" data-r="gross">${fmt$(st.annual_gross)}</span>
        <span class="sub" data-r="mo"></span>
        <button class="mini cfg-btn" title="Range & tax">⚙</button>
        <button class="mini del" title="Delete stream">✕</button>
      </div>
      <input type="range" min="${st.slider_min}" max="${st.slider_max}" step="500" value="${st.annual_gross}">
      <div class="stream-cfg">
        <label>Min $ <input type="number" class="cfg-min" value="${st.slider_min}" step="1000"></label>
        <label>Max $ <input type="number" class="cfg-max" value="${st.slider_max}" step="1000"></label>
        <label>Tax % <input type="number" class="cfg-tax" value="${st.tax_rate ?? ""}" placeholder="${state.settings.default_tax_rate}" step="0.5" min="0" max="60"></label>
      </div>`;

    const range = $('input[type="range"]', div);
    range.addEventListener("input", () => {
      st.annual_gross = +range.value;
      $('[data-r="gross"]', div).textContent = fmt$(st.annual_gross);
      updateIncomeSummary();
      updateCategoryDollars();
      updateGoalNumbers();
      debounce(`stream${st.id}`, () => api("PATCH", `/api/streams/${st.id}`, { annual_gross: st.annual_gross }));
    });

    $(".name", div).addEventListener("change", (e) => {
      st.name = e.target.value;
      api("PATCH", `/api/streams/${st.id}`, { name: st.name });
    });
    $(".cfg-btn", div).addEventListener("click", () => div.classList.toggle("cfg-open"));
    $(".del", div).addEventListener("click", async () => {
      await api("DELETE", `/api/streams/${st.id}`);
      state.active.income_streams = state.active.income_streams.filter((x) => x.id !== st.id);
      render();
    });
    $(".cfg-min", div).addEventListener("change", (e) => {
      st.slider_min = +e.target.value;
      range.min = st.slider_min;
      api("PATCH", `/api/streams/${st.id}`, { slider_min: st.slider_min });
    });
    $(".cfg-max", div).addEventListener("change", (e) => {
      st.slider_max = +e.target.value;
      range.max = st.slider_max;
      api("PATCH", `/api/streams/${st.id}`, { slider_max: st.slider_max });
    });
    $(".cfg-tax", div).addEventListener("change", (e) => {
      const v = e.target.value.trim();
      st.tax_rate = v === "" ? null : +v;
      api("PATCH", `/api/streams/${st.id}`, v === "" ? { clear_tax_rate: true } : { tax_rate: st.tax_rate });
      updateIncomeSummary();
      updateCategoryDollars();
      updateGoalNumbers();
    });

    box.appendChild(div);
  }
  updateIncomeSummary();
}

function updateIncomeSummary() {
  const g = grossAnnual(), n = netAnnual();
  $("#sum-gross-yr").textContent = fmt$(g);
  $("#sum-gross-mo").textContent = fmt$(g / 12);
  $("#sum-net-yr").textContent = fmt$(n);
  $("#sum-net-mo").textContent = fmt$(n / 12);
  $$("#streams .stream").forEach((div, i) => {
    const st = state.active.income_streams[i];
    if (st) $('[data-r="mo"]', div).textContent = fmt$(st.annual_gross / 12) + "/mo gross";
  });
}

function renderCategories() {
  const box = $("#categories");
  box.innerHTML = "";
  for (const cat of state.active.categories) {
    const div = document.createElement("div");
    div.className = "cat" + (cat.locked ? " locked" : "");
    div.dataset.id = cat.id;
    div.innerHTML = `
      <div class="cat-head">
        <button class="mini lock ${cat.locked ? "active" : ""}" title="Lock: keep this % fixed while others rebalance">${cat.locked ? "🔒" : "🔓"}</button>
        <input class="name" value="${esc(cat.name)}">
        <span class="pct">${fmtPct(cat.pct)}</span>
        <div class="dollars">
          <span class="amount accent" data-r="yr"></span>
          <span class="sub" data-r="mo"></span>
        </div>
        <button class="mini cfg-btn" title="Goal & options">⚙</button>
        <button class="mini del" title="Delete category">✕</button>
      </div>
      <input type="range" min="0" max="100" step="0.5" value="${cat.pct}" ${cat.locked ? "disabled" : ""}>
      <div class="warn-note" hidden></div>
      <div class="cat-cfg">
        <label><input type="checkbox" class="cfg-roth" ${cat.is_roth ? "checked" : ""}> Roth IRA (check against limit)</label>
        <label>Goal $ <input type="number" class="cfg-target" value="${cat.target_amount ?? ""}" placeholder="none" step="500" min="0"></label>
      </div>`;

    const range = $('input[type="range"]', div);
    range.addEventListener("input", () => {
      rebalance(state.active.categories, cat.id, +range.value);
      updateAllPctUI();
      persistPcts();
    });

    $(".lock", div).addEventListener("click", () => {
      cat.locked = cat.locked ? 0 : 1;
      api("PATCH", `/api/categories/${cat.id}`, { locked: !!cat.locked });
      renderCategories();
    });
    $(".name", div).addEventListener("change", (e) => {
      cat.name = e.target.value;
      api("PATCH", `/api/categories/${cat.id}`, { name: cat.name });
      renderGoals();
    });
    $(".cfg-btn", div).addEventListener("click", () => div.classList.toggle("cfg-open"));
    $(".del", div).addEventListener("click", async () => {
      if (!confirm(`Delete "${cat.name}"? Its ${fmtPct(cat.pct)} will need re-allocating.`)) return;
      await api("DELETE", `/api/categories/${cat.id}`);
      state.active.categories = state.active.categories.filter((x) => x.id !== cat.id);
      render();
    });
    $(".cfg-roth", div).addEventListener("change", (e) => {
      cat.is_roth = e.target.checked ? 1 : 0;
      api("PATCH", `/api/categories/${cat.id}`, { is_roth: !!cat.is_roth });
      updateAllPctUI();
    });
    $(".cfg-target", div).addEventListener("change", (e) => {
      const v = e.target.value.trim();
      cat.target_amount = v === "" ? null : +v;
      api("PATCH", `/api/categories/${cat.id}`, v === "" ? { clear_target: true } : { target_amount: cat.target_amount });
      renderGoals();
    });

    box.appendChild(div);
  }
  updateAllPctUI();
}

function updateAllPctUI() {
  const total = state.active.categories.reduce((s, c) => s + c.pct, 0);
  const pill = $("#alloc-total");
  pill.textContent = fmtPct(total);
  pill.classList.toggle("bad", Math.abs(total - 100) > 0.01);

  const rothLimit = parseFloat(state.settings.roth_limit) || 0;
  $$("#categories .cat").forEach((div) => {
    const cat = state.active.categories.find((c) => c.id === +div.dataset.id);
    if (!cat) return;
    $(".pct", div).textContent = fmtPct(cat.pct);
    const range = $('input[type="range"]', div);
    if (document.activeElement !== range) range.value = cat.pct;

    const yr = catAnnual(cat);
    $('[data-r="yr"]', div).textContent = fmt$(yr) + "/yr";
    $('[data-r="mo"]', div).textContent = fmt$(yr / 12) + "/mo";

    const over = cat.is_roth && yr > rothLimit;
    div.classList.toggle("warn", over);
    const note = $(".warn-note", div);
    note.hidden = !over;
    if (over) note.textContent = `⚠ ${fmt$(yr)} exceeds the ${fmt$(rothLimit)} Roth IRA annual limit by ${fmt$(yr - rothLimit)}`;
  });
  updateGoalNumbers();
}

function updateCategoryDollars() { updateAllPctUI(); }

function persistPcts() {
  debounce("pcts", () => {
    const pcts = Object.fromEntries(state.active.categories.map((c) => [c.id, c.pct]));
    api("PUT", `/api/scenarios/${state.active.id}/pcts`, { pcts });
  });
}

function renderGoals() {
  const box = $("#goals");
  const goals = state.active.categories.filter((c) => c.target_amount != null);
  if (!goals.length) {
    box.innerHTML = `<div class="sub">No goals yet — open a category's ⚙ and set a Goal $.</div>`;
    return;
  }
  box.innerHTML = "";
  for (const cat of goals) {
    const div = document.createElement("div");
    div.className = "goal";
    div.dataset.id = cat.id;
    div.innerHTML = `
      <div class="goal-head">
        <span class="name">${esc(cat.name)}</span>
        <span class="eta"></span>
      </div>
      <div class="progress"><div></div></div>
      <div class="nums">
        <label>Balance $ <input type="number" class="bal" value="${cat.current_balance}" step="100" min="0"></label>
        <span class="spacer"></span>
        <span class="tgt"></span>
      </div>`;
    $(".bal", div).addEventListener("change", (e) => {
      cat.current_balance = +e.target.value || 0;
      api("PATCH", `/api/categories/${cat.id}`, { current_balance: cat.current_balance });
      updateGoalNumbers();
    });
    box.appendChild(div);
  }
  updateGoalNumbers();
}

function updateGoalNumbers() {
  $$("#goals .goal").forEach((div) => {
    const cat = state.active.categories.find((c) => c.id === +div.dataset.id);
    if (!cat || cat.target_amount == null) return;
    const pctDone = Math.min(100, (cat.current_balance / cat.target_amount) * 100);
    $(".progress > div", div).style.width = pctDone + "%";
    const months = monthsToGoal(cat);
    const eta = $(".eta", div);
    eta.textContent = etaLabel(months);
    eta.classList.toggle("never", !isFinite(months));
    $(".tgt", div).textContent =
      `${fmt$(cat.current_balance)} / ${fmt$(cat.target_amount)} · ${fmt$(catAnnual(cat) / 12)}/mo`;
  });
}

// ---------- scenario actions ----------

async function loadState() {
  state = await api("GET", "/api/state");
  render();
}

$("#scenario-select").addEventListener("change", async (e) => {
  state.active = await api("PUT", `/api/scenarios/${e.target.value}/activate`);
  render();
});

$("#btn-save-as").addEventListener("click", async () => {
  const name = prompt("New scenario name:", state.active.name + " (copy)");
  if (!name) return;
  const sc = await api("POST", "/api/scenarios", { name, duplicate_from: state.active.id });
  await api("PUT", `/api/scenarios/${sc.id}/activate`);
  await loadState();
  toast(`Saved as "${name}"`);
});

$("#btn-rename").addEventListener("click", async () => {
  const name = prompt("Rename scenario:", state.active.name);
  if (!name) return;
  await api("PUT", `/api/scenarios/${state.active.id}`, { name });
  await loadState();
});

$("#btn-delete-scenario").addEventListener("click", async () => {
  if (state.scenarios.length <= 1) return toast("Can't delete the last scenario");
  if (!confirm(`Delete scenario "${state.active.name}"?`)) return;
  await api("DELETE", `/api/scenarios/${state.active.id}`);
  await loadState();
});

// ---------- compare ----------

$("#btn-compare").addEventListener("click", () => {
  const [a, b] = [$("#cmp-a"), $("#cmp-b")];
  const opts = state.scenarios.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
  a.innerHTML = opts;
  b.innerHTML = opts;
  a.value = state.active.id;
  const other = state.scenarios.find((s) => s.id !== state.active.id);
  if (other) b.value = other.id;
  $("#compare-overlay").hidden = false;
  renderCompare();
});

$("#cmp-a").addEventListener("change", renderCompare);
$("#cmp-b").addEventListener("change", renderCompare);

async function renderCompare() {
  const [aId, bId] = [$("#cmp-a").value, $("#cmp-b").value];
  const [A, B] = await Promise.all([
    api("GET", `/api/scenarios/${aId}`),
    api("GET", `/api/scenarios/${bId}`),
  ]);
  const def = parseFloat(state.settings.default_tax_rate) || 0;
  const net = (sc) => sc.income_streams.reduce(
    (s, x) => s + x.annual_gross * (1 - (x.tax_rate == null ? def : x.tax_rate) / 100), 0);
  const netA = net(A), netB = net(B);

  const mTo = (sc, scNet, cat) => {
    if (cat.target_amount == null) return null;
    const rem = cat.target_amount - cat.current_balance;
    if (rem <= 0) return 0;
    const pm = (scNet * cat.pct / 100) / 12;
    return pm > 0 ? rem / pm : Infinity;
  };
  const mLbl = (m) => m === null ? "—" : m === 0 ? "funded" : isFinite(m) ? (m / 12 >= 1 ? (m / 12).toFixed(1) + " yr" : Math.ceil(m) + " mo") : "never";

  const goalNames = [...new Set([...A.categories, ...B.categories]
    .filter((c) => c.target_amount != null).map((c) => c.name))];

  const goalRows = goalNames.map((name) => {
    const ca = A.categories.find((c) => c.name === name);
    const cb = B.categories.find((c) => c.name === name);
    const ma = ca ? mTo(A, netA, ca) : null;
    const mb = cb ? mTo(B, netB, cb) : null;
    const aBetter = ma !== null && mb !== null && ma < mb;
    const bBetter = ma !== null && mb !== null && mb < ma;
    return `<tr><td>${esc(name)}</td>
      <td class="num ${aBetter ? "better" : ""}">${mLbl(ma)}</td>
      <td class="num ${bBetter ? "better" : ""}">${mLbl(mb)}</td></tr>`;
  }).join("");

  const inc = (label, va, vb, better = "higher") => {
    const aB = better === "higher" ? va > vb : va < vb;
    const bB = better === "higher" ? vb > va : vb < va;
    return `<tr><td>${label}</td>
      <td class="num ${aB ? "better" : ""}">${fmt$(va)}</td>
      <td class="num ${bB ? "better" : ""}">${fmt$(vb)}</td></tr>`;
  };

  $("#compare-body").innerHTML = `
    <div class="cmp-section">Income</div>
    <div class="cmp-table-wrap"><table class="cmp-table">
      <tr><th></th><th>${esc(A.name)}</th><th>${esc(B.name)}</th></tr>
      ${inc("Gross / yr", A.income_streams.reduce((s, x) => s + x.annual_gross, 0), B.income_streams.reduce((s, x) => s + x.annual_gross, 0))}
      ${inc("Take-home / yr", netA, netB)}
      ${inc("Take-home / mo", netA / 12, netB / 12)}
    </table></div>
    <div class="cmp-section">Time to goal</div>
    <div class="cmp-table-wrap"><table class="cmp-table">
      <tr><th>Goal</th><th>${esc(A.name)}</th><th>${esc(B.name)}</th></tr>
      ${goalRows || `<tr><td colspan="3" class="sub">No goals in either scenario</td></tr>`}
    </table></div>`;
}

// ---------- settings ----------

$("#btn-settings").addEventListener("click", () => {
  $("#set-roth-limit").value = state.settings.roth_limit;
  $("#set-tax-rate").value = state.settings.default_tax_rate;
  $("#settings-overlay").hidden = false;
});

$("#btn-save-settings").addEventListener("click", async () => {
  state.settings = await api("PUT", "/api/settings", {
    roth_limit: $("#set-roth-limit").value,
    default_tax_rate: $("#set-tax-rate").value,
  });
  $("#settings-overlay").hidden = true;
  render();
  toast("Settings saved");
});

// ---------- add buttons ----------

$("#btn-add-stream").addEventListener("click", async () => {
  const st = await api("POST", `/api/scenarios/${state.active.id}/streams`, {});
  state.active.income_streams.push(st);
  render();
});

$("#btn-add-cat").addEventListener("click", async () => {
  const cat = await api("POST", `/api/scenarios/${state.active.id}/categories`, {});
  state.active.categories.push(cat);
  render();
});

// ---------- export / import ----------

$("#btn-export").addEventListener("click", () => {
  window.location.href = "/api/export";
});

$("#btn-import").addEventListener("click", () => $("#import-file").click());
$("#import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!confirm("Importing replaces ALL current data. Continue?")) return;
    await api("POST", "/api/import", data);
    await loadState();
    toast("Import complete");
  } catch (err) {
    toast("Import failed: " + err.message, 4000);
  } finally {
    e.target.value = "";
  }
});

// ---------- overlays ----------

$$("[data-close]").forEach((btn) =>
  btn.addEventListener("click", () => ($("#" + btn.dataset.close).hidden = true)));
$$(".overlay").forEach((ov) =>
  ov.addEventListener("click", (e) => { if (e.target === ov) ov.hidden = true; }));

// ---------- go ----------

loadState().catch((e) => toast("Failed to load: " + e.message, 6000));
