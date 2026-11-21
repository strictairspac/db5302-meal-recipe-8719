import {heading, panel} from '../components/common/heading.js';
import {entries, records} from '../components/common/records.js';
import {date, esc} from '../utils/dom.js';
import {topic} from '../constants/project.js';
import {submit} from '../hooks/submit.js';

function nameMap(payload) {
  const map = new Map();
  [...(payload.recipes || []), ...(payload.ingredients || [])].forEach(row=>map.set(row.recipe || row.ingredient, row.name));
  return map;
}

function effectiveRatio(state, caseId, parent, component) {
  const chain = state.errata.filter(row=>row.case_id===caseId && row.parent===parent && row.component===component);
  if (chain.length) return chain.reduce((a, b)=>(a.id > b.id ? a : b)).new_qty;
  const selected = state.cases.find(row=>row.id===caseId);
  const edge = (selected?.payload.components || []).find(row=>row.parent===parent && row.component===component);
  return edge ? edge.qty : '—';
}

function sumSigned(values) {
  return values.reduce((total, value)=>total + Math.round(Number(value) * 1000), 0) / 1000;
}

const signed = value=>value > 0 ? `+${value}` : `${value}`;

function compensationList(state, errata) {
  const rows = state.compensations.filter(row=>row.errata_id===errata.id);
  if (!rows.length) return '';
  const flat = [];
  const untouched = [];
  rows.forEach(row=>{
    const link = `<a href="#runs/${row.run_id}">执行 ${row.run_id}</a>`;
    if (!row.detail.rows.length) { untouched.push(link); return; }
    row.detail.rows.forEach(item=>flat.push([link, `${esc(item['原料'])}（${esc(item['原料编号'])}）`,
      `${esc(item['每包数量'])} ${esc(item['单位'])}`, esc(item['原建议包数']), esc(item['新建议包数']),
      esc(item['包数差']), `${esc(item['采购量差'])} ${esc(item['单位'])}`]));
  });
  const totals = new Map();
  rows.forEach(row=>row.detail.rows.forEach(item=>{
    const entry = totals.get(item['原料编号']) || {name: item['原料'], unit: item['单位'], packs: [], quantities: []};
    entry.packs.push(item['包数差']);
    entry.quantities.push(item['采购量差']);
    totals.set(item['原料编号'], entry);
  }));
  const totalRows = [...totals.entries()].map(([code, entry])=>[
    `${esc(entry.name)}（${esc(code)}）`, esc(signed(sumSigned(entry.packs))), `${esc(signed(sumSigned(entry.quantities)))} ${esc(entry.unit)}`]);
  return `<details><summary>补差清单 · 勘误 ${errata.id}（已补 ${rows.length} 张原单）</summary>
    ${flat.length ? records(['原单执行', '原料', '每包数量', '原建议包数', '新建议包数', '包数差', '采购量差'], flat) : ''}
    ${untouched.length ? `<p class="note">${untouched.join('、')} 走过该关系，包数无变化。</p>` : ''}
    ${totalRows.length ? records(['原料', '包数差合计', '采购量差合计'], totalRows) : ''}</details>`;
}

function errataSection(state, selected) {
  const names = nameMap(selected.payload);
  const label = code=>`${names.get(code) || code}（${code}）`;
  const list = state.errata.filter(row=>row.case_id===selected.id).sort((a, b)=>a.id - b.id);
  const operator = state.session.role==='operator';
  const rows = list.map(item=>{
    const compensated = state.compensations.filter(row=>row.errata_id===item.id).length;
    const pending = state.runs.filter(run=>run.case_id===selected.id && run.created_at < item.created_at
      && ['queued', 'running'].includes(run.status)).length;
    const action = operator ? `<button type="button" class="secondary compensate" data-errata="${item.id}">${compensated ? '更新' : '生成'}补差清单</button>` : '';
    return [esc(date(item.created_at)), `${esc(label(item.parent))} → ${esc(label(item.component))}`,
      `${esc(item.old_qty)} → ${esc(item.new_qty)}`, esc(item.actor), esc(item.note || '—'),
      `已补 ${compensated} 单${pending ? ` · 在途旧单 ${pending}` : ''} ${action}`];
  });
  const components = selected.payload.components || [];
  const parents = [...new Set(components.map(row=>row.parent))];
  const form = operator && parents.length ? `<form id="errata-form">
    <div class="field-grid"><label class="field"><span>上级配方</span><select name="parent" id="errata-parent">${parents.map(code=>`<option value="${esc(code)}">${esc(label(code))}</option>`).join('')}</select></label>
    <label class="field"><span>下级配方或原料</span><select name="component" id="errata-component"></select></label>
    <label class="field"><span>改正后比例</span><input name="qty" type="number" step="any" min="0.001" max="100" required></label>
    <label class="field"><span>勘误说明</span><input name="note" maxlength="200" placeholder="选填"></label></div>
    <p class="note" id="errata-current"></p>
    <div class="actions form-actions"><button>登记勘误</button></div></form>` : '';
  return panel('配比勘误与采购补差',
    records(['登记时间', '投料关系', '比例调整', '登记', '说明', '补差'], rows, '尚未登记勘误。投料比例填错时，经办员可在此登记勘误，新提交的执行按改正比例出单。')
    + list.map(item=>compensationList(state, item)).join('')
    + (list.some(item=>state.runs.some(run=>run.case_id===selected.id && run.created_at < item.created_at && ['queued', 'running'].includes(run.status)))
      ? '<p class="note">有旧单仍在排队或执行，晚出的旧单出单后再次生成补差即可补上。</p>' : '')
    + form);
}

export function casesPage(state, identity) {
  const {spec, session, cases, runs} = state;
  const selected = cases.find(row=>row.id===identity) || cases[0];
  state.selectedCase = selected || null;
  const operator = session.role==='operator';
  const rows = cases.map(row=>[`<a href="#cases/${row.id}" ${row.id===selected?.id?'aria-current="true"':''}>${esc(row.title)}</a>`, esc(row.author), esc(date(row.created_at))]);
  const instruction = selected ? `<h2>${esc(selected.title)}</h2><p>${esc(spec.guidance)}</p>` : '';
  const input = selected ? Object.entries(selected.payload).map(([key, value])=>{
    const label = spec.field_labels[key] || key;
    const rows = Array.isArray(value) && value.every(x=>x && typeof x === 'object' && !Array.isArray(x));
    return panel(label, rows ? entries(value.slice(0,10), spec.field_labels) + (value.length>10?`<p class="note">显示前 10 条，共 ${value.length} 条。</p>`:'') : `<pre>${esc(value)}</pre>`);
  }).join('') : '';
  return `${heading(topic.modules[0], spec.summary, operator?'<a class="button" href="#editor">建立档案</a>':'')}
    <div class="spread"><section aria-label="档案目录">${records([spec.entity_labels[0], '经办', '建立时间'], rows, '尚未建立档案。经办员可以从演示资料建立第一份。')}</section>
    <aside class="brief">${instruction || `<h2>${esc(spec.customer)}</h2>`}${selected?`<p class="note">该档案记录 ${runs.filter(row=>row.case_id===selected.id).length} 次执行。</p>`:''}${selected&&operator?`<a href="#editor/${selected.id}">复制为新档案</a>`:''}</aside></div>
    ${input ? `<div class="inspection">${input}</div>`:''}
    ${selected ? errataSection(state, selected) : ''}`;
}

export function bindCases(state, api, update, fail) {
  const selected = state.selectedCase;
  document.querySelectorAll('button.compensate').forEach(button=>button.addEventListener('click', async()=>{
    button.disabled = true;
    try {
      const result = await api(`/errata/${button.dataset.errata}/compensations`, {method:'POST'});
      await update();
      const message = document.getElementById('message');
      if (message) {
        message.textContent = result.issued ? `本次新增 ${result.issued} 条补差记录。` : '没有新的待补原单，补差清单已是最新。';
        message.className = 'note';
      }
    } catch (error) { fail(error); }
  }));
  const form = document.getElementById('errata-form');
  if (!form || !selected) return;
  const components = selected.payload.components || [];
  const parentSelect = document.getElementById('errata-parent');
  const componentSelect = document.getElementById('errata-component');
  const names = nameMap(selected.payload);
  const refreshComponents = ()=>{
    componentSelect.innerHTML = components.filter(row=>row.parent===parentSelect.value)
      .map(row=>`<option value="${esc(row.component)}">${esc(names.get(row.component) || row.component)}（${esc(row.component)}）</option>`).join('');
    refreshCurrent();
  };
  const refreshCurrent = ()=>{
    const current = effectiveRatio(state, selected.id, parentSelect.value, componentSelect.value);
    document.getElementById('errata-current').textContent = `当前比例：${current}。登记后，新提交的执行按改正比例出单，已排队或在跑的执行仍按原比例出单。`;
  };
  parentSelect.addEventListener('change', refreshComponents);
  componentSelect.addEventListener('change', refreshCurrent);
  refreshComponents();
  submit('errata-form', async data=>{
    await api(`/cases/${selected.id}/errata`, {method:'POST', data:{
      parent: data.get('parent'), component: data.get('component'),
      qty: data.get('qty'), note: data.get('note') || ''}});
    await update();
  }, fail);
}
