// Content script running on target pages
console.log("LicenseAssist Content Script Loaded:", window.location.href);

let siteMapping = null;

// Load field mappings
async function loadMappings() {
  try {
    const mappingUrl = chrome.runtime.getURL('mapping.json');
    const resp = await fetch(mappingUrl);
    if (!resp.ok) throw new Error(`Mapping fetch failed: ${resp.statusText}`);
    const all = await resp.json();
    const url = window.location.href;

    siteMapping = Object.entries(all)
      .find(([pattern, map]) => {
        const esc = pattern
          .replace(/[.+?^${}()|[\\]\\]/g, '\\$&')
          .replace(/\*/g, '.*');
        return new RegExp(`^${esc}$`).test(url);
      })?.[1] || null;

    console.log(siteMapping ? "Mappings loaded" : "No mappings for this URL");
  } catch (e) {
    console.error("Error loading mappings:", e);
    siteMapping = null;
  }
}

// SPA navigation hooks
async function init() { await loadMappings(); }
window.addEventListener('hashchange', init);
window.addEventListener('popstate', init);
(function(history) {
  const push = history.pushState, replace = history.replaceState;
  history.pushState = function(...args) {
    const ret = push.apply(this, args);
    window.dispatchEvent(new Event('locationchange'));
    return ret;
  };
  history.replaceState = function(...args) {
    const ret = replace.apply(this, args);
    window.dispatchEvent(new Event('locationchange'));
    return ret;
  };
})(window.history);
window.addEventListener('locationchange', init);
init();

// Listen for fillForm
chrome.runtime.onMessage.addListener((msg, _, send) => {
  if (msg.action !== 'fillForm') return;

  if (!siteMapping) {
    send({ status: 'error', message: 'No field mappings loaded.' });
    return;
  }

  chrome.storage.local.get('currentPhysicianData', ({ currentPhysicianData }) => {
    if (!currentPhysicianData) {
      send({ status: 'error', message: 'No physician data in storage.' });
      return;
    }

    const result = fillFieldsOnPage(currentPhysicianData, siteMapping);
    console.log("Fill result:", result);
    send({ status: 'success', ...result });
  });

  return true;
});

// Helpers
function dispatchEvents(el, evts = ['input','change','blur']) {
  evts.forEach(e => el.dispatchEvent(new Event(e, { bubbles: true, cancelable: true })));
}

function formatDate(i, fmt = 'MM/DD/YYYY') {
  if (!i) return '';
  let d = new Date(i);
  if (isNaN(d)) {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(i);
    if (m) {
      let [, mo, da, yr] = m;
      yr = yr.length === 2
        ? (+yr < 50 ? 2000 + +yr : 1900 + +yr)
        : +yr;
      d = new Date(yr, mo - 1, da);
    }
  }
  if (isNaN(d)) return `FORMAT_ERROR:${i}`;
  const yyyy = d.getFullYear(),
        mm = String(d.getMonth() + 1).padStart(2, '0'),
        dd = String(d.getDate()).padStart(2, '0');
  return fmt === 'YYYY-MM-DD'
    ? `${yyyy}-${mm}-${dd}`
    : `${mm}/${dd}/${yyyy}`;
}

function formatPhone(p) {
  if (!p) return '';
  const digs = `${p}`.replace(/\D/g, '');
  if (digs.length === 10) return `(${digs.slice(0,3)}) ${digs.slice(3,6)}-${digs.slice(6)}`;
  if (digs.length === 11 && digs.startsWith('1'))
    return `(${digs.slice(1,4)}) ${digs.slice(4,7)}-${digs.slice(7)}`;
  return p;
}

function getKendo(el) {
  if (window.kendo && typeof kendo.widgetInstance === 'function') {
    return kendo.widgetInstance(el);
  }
  if (window.$) {
    return $(el).data('kendoDropDownList') || null;
  }
  return null;
}

function fillFieldsOnPage(data, mapping) {
  let filled = 0, issues = [];
  for (let field in mapping) {
    let val = data[field];
    if ((val == null || val === '') && field.includes('_')) {
      val = data[field.replace(/_/g, '')];
    }
    if ((val == null || val === '') && field === 'DifferentAddress') {
      val = 'false';
    }
    if (val == null || val === '') continue;

    if (['DOB','DateDegreeIssued','ResidencyCompletionDate','BoardCert Date']
      .includes(field)) {
      val = formatDate(val);
    } else if (field === 'Phone') {
      val = formatPhone(val);
    }

    const entry = mapping[field];
    if (Array.isArray(entry)) {
      entry.forEach(sel => {
        const el = document.querySelector(sel);
        if (!el) return issues.push(`Not found: ${field} (${sel})`);
        try {
          fillSingle(el, val, field);
          filled++;
        } catch (e) {
          issues.push(`Error ${field}: ${e.message}`);
        }
      });
    } else {
      const sels = [entry].flat();
      let el = null;
      for (let s of sels) {
        el = document.querySelector(s);
        if (el) break;
      }
      if (!el) {
        issues.push(`Not found: ${field}`);
        continue;
      }
      try {
        fillSingle(el, val, field);
        filled++;
      } catch (e) {
        issues.push(`Error ${field}: ${e.message}`);
      }
    }
  }
  return { filledCount: filled, issues };
}

function fillSingle(el, val, field) {
  const tag = el.tagName.toUpperCase(),
        type = tag === 'INPUT' ? el.type.toLowerCase() : null;

  // ——— Default HomeCountry to “United States” if blank ———
  if (field === 'HomeCountry' && (!val || val === '')) {
    if (tag === 'SELECT' && el.getAttribute('data-role') === 'dropdownlist') {
      const widget = getKendo(el);
      if (widget) {
        const us = widget.dataSource.data().find(o => (o.name||o.text) === 'United States');
        if (us) {
          widget.value(us.id);
          widget.trigger('change');
          dispatchEvents(el);
          return;
        }
      }
    }
    for (let o of el.options) {
      if (o.text === 'United States') {
        el.value = o.value;
        dispatchEvents(el);
        return;
      }
    }
  }

  // Kendo dropdown?
  if (tag === 'SELECT' && el.getAttribute('data-role') === 'dropdownlist') {
    const widget = getKendo(el);
    if (widget) {
      widget.value(val);
      if (!widget.value()) {
        const it = widget.dataSource.data()
          .find(o => o.name === val || o.text === val || String(o.id) === String(val));
        if (it) widget.value(it.id);
      }
      widget.trigger('change');
      dispatchEvents(el);
      return;
    }
    console.warn(`No Kendo widget for ${field}, falling back`);
  }

  // Fallback for native <select>
  if (tag === 'SELECT') {
    let found = false;
    for (let o of el.options) {
      if (o.value === String(val) || o.text === String(val)) {
        el.value = o.value;
        dispatchEvents(el);
        found = true;
        break;
      }
    }
    if (!found) throw new Error(`Option not found for ${field}: ${val}`);
    return;
  }

  // Text & textarea
  if ((tag==='INPUT' && ['text','email','number','tel'].includes(type)) || tag==='TEXTAREA') {
    el.value = val;
    dispatchEvents(el);
    return;
  }

  // Date input
  if (tag === 'INPUT' && type === 'date') {
    el.value = formatDate(val, 'YYYY-MM-DD');
    dispatchEvents(el);
    return;
  }

  // Checkbox
  if (tag === 'INPUT' && type === 'checkbox') {
    const yes = ['true','yes','1'].includes(String(val).toLowerCase());
    if (el.checked !== yes) el.click();
    return;
  }

  // Radio
  if (tag === 'INPUT' && type === 'radio') {
    document.querySelectorAll(`input[name="${el.name}"][type=radio]`)
      .forEach(r => {
        if (String(r.value) === String(val) && !r.checked) r.click();
      });
    return;
  }

  throw new Error(`Unsupported: ${field} (${tag}/${type})`);
}
