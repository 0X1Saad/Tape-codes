(function () {
  "use strict";

  var API = ((window.APP_CONFIG && window.APP_CONFIG.API_URL) || "").replace(/\/+$/, "");
  var TOKEN_KEY = "edge_tapes_token";
  var LOW_STOCK = 3;

  // ---------- Session ----------
  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; }
  }
  if (!getToken()) {
    location.replace("login.html");
    return;
  }

  // ---------- Elements ----------
  function $(id) { return document.getElementById(id); }

  var el = {
    fSearch: $("fSearch"), clearSearch: $("clearSearch"), addBtn: $("addBtn"), logoutBtn: $("logoutBtn"),
    resultLine: $("resultLine"),
    netDot: $("netDot"), netState: $("netState"), pendingState: $("pendingState"),
    lastSync: $("lastSync"), appState: $("appState"), syncBtn: $("syncBtn"),
    authBanner: $("authBanner"), rejectBanner: $("rejectBanner"),
    sRolls: $("sRolls"), sCodes: $("sCodes"), sGlass: $("sGlass"), sMatt: $("sMatt"),
    sLow: $("sLow"), sLowSub: $("sLowSub"),
    fType: $("fType"), fSize: $("fSize"), fAvail: $("fAvail"), fStock: $("fStock"), fDup: $("fDup"),
    fSort: $("fSort"), fStep: $("fStep"),
    body: $("tapeBody"), empty: $("emptyMsg"),
    pagerInfo: $("pagerInfo"), pagerNav: $("pagerNav"), pageSize: $("pageSize"),
    dlg: $("tapeDialog"), form: $("tapeForm"), dlgTitle: $("dlgTitle"), dlgMsg: $("dlgMsg"),
    dlgSave: $("dlgSave"), dlgCancel: $("dlgCancel"), dlgClose: $("dlgClose"),
    tId: $("tId"), tCode: $("tCode"), tType: $("tType"), tSize: $("tSize"),
    tQty: $("tQty"), tAvail: $("tAvail"), tNotes: $("tNotes"),
    cf: $("confirmDialog"), cfTitle: $("cfTitle"), cfText: $("cfText"), cfOk: $("cfOk"), cfCancel: $("cfCancel")
  };

  // ---------- State ----------
  var tapes = [];
  var pending = {};
  var pendingCount = 0;
  var lastSync = 0;
  var loadedOnce = false;
  var syncing = false;
  var authLost = false;
  var page = 1;
  var pageSize = 25;
  var touchedId = null;  // tape just added/edited: jump to it and flash it
  var jump = false;

  // ---------- Helpers ----------
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // Works on plain http too (crypto.randomUUID needs https)
  function uuid() {
    var b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return x.toString(16).padStart(2, "0"); }).join("");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  }

  function makeOp(type, id, extra) {
    var op = { opId: uuid(), type: type, id: id, at: Date.now() };
    Object.keys(extra || {}).forEach(function (k) { op[k] = extra[k]; });
    return op;
  }

  var toastTimer = null;
  function showToast(text) {
    var old = document.getElementById("toast");
    if (old) old.remove();
    clearTimeout(toastTimer);
    var t = document.createElement("div");
    t.id = "toast"; t.className = "toast"; t.setAttribute("role", "alert");
    t.textContent = text;
    // inside the open pop-up, so it shows above it (top layer)
    var host = document.querySelector("dialog[open]") || document.body;
    host.appendChild(t);
    function gone() { clearTimeout(toastTimer); if (t.parentNode) t.remove(); }
    t.addEventListener("click", gone);
    toastTimer = setTimeout(gone, 4500);
  }

  function dupKey(t) { return [t.code, t.type, t.size].join("|").toLowerCase(); }
  function byCode(a, b) { return String(a.code).localeCompare(String(b.code), undefined, { numeric: true }); }
  function query() { return el.fSearch.value.trim().toLowerCase(); }

  function timeText(ms) {
    if (!ms) return "never";
    var diff = Math.round((Date.now() - ms) / 1000);
    if (diff < 10) return "just now";
    if (diff < 60) return diff + " seconds ago";
    if (diff < 3600) return Math.round(diff / 60) + " min ago";
    var d = new Date(ms);
    return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  // ---------- Pop-up helpers ----------
  function openDlg(d) {
    if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", "");
  }
  function closeDlg(d) {
    if (typeof d.close === "function") { if (d.open) d.close(); } else d.removeAttribute("open");
  }

  function askConfirm(title, text, okLabel) {
    return new Promise(function (resolve) {
      el.cfTitle.textContent = title;
      el.cfText.textContent = text;
      el.cfOk.textContent = okLabel || "YES";
      var done = function (v) {
        el.cfOk.onclick = el.cfCancel.onclick = null;
        el.cf.onclose = null;
        closeDlg(el.cf);
        resolve(v);
      };
      el.cfOk.onclick = function () { done(true); };
      el.cfCancel.onclick = function () { done(false); };
      el.cf.onclose = function () { done(false); }; // Esc
      openDlg(el.cf);
      el.cfCancel.focus();
    });
  }

  // ---------- Data ----------
  function refresh() {
    return Promise.all([
      TapesDB.getAll(), TapesDB.getPendingIds(), TapesDB.countOutbox(), TapesDB.getMeta("lastSync")
    ]).then(function (r) {
      tapes = r[0];
      pending = r[1];
      pendingCount = r[2];
      lastSync = r[3] || 0;
      loadedOnce = true;
      renderAll();
    });
  }

  function commit(ops) {
    return TapesDB.applyLocal(ops).then(refresh).then(function () { requestSync(); });
  }

  // ---------- Rendering ----------
  function renderStatus() {
    var online = navigator.onLine;
    el.netState.textContent = online ? "ONLINE" : "OFFLINE";
    el.netDot.className = "dot" + (online ? (syncing ? " busy" : "") : " off");

    if (syncing) el.pendingState.textContent = "Syncing...";
    else if (pendingCount > 0) el.pendingState.textContent = pendingCount + (pendingCount === 1 ? " change" : " changes") + " waiting to sync";
    else el.pendingState.textContent = "All changes saved";

    el.lastSync.textContent = "Last sync: " + timeText(lastSync);
    el.syncBtn.disabled = !online || syncing || authLost;
    el.authBanner.hidden = !authLost;
  }

  function renderStats() {
    var rolls = 0, glass = 0, matt = 0, low = 0, out = 0;
    tapes.forEach(function (t) {
      var q = Number(t.quantity);
      rolls += q;
      if (t.type === "Glass") glass += q;
      if (t.type === "Matt") matt += q;
      if (q === 0) out++; else if (q <= LOW_STOCK) low++;
    });
    el.sRolls.textContent = rolls.toLocaleString("en-US");
    el.sCodes.textContent = tapes.length.toLocaleString("en-US");
    el.sGlass.textContent = glass.toLocaleString("en-US");
    el.sMatt.textContent = matt.toLocaleString("en-US");
    el.sLow.textContent = low + out;
    el.sLowSub.textContent = out + " out of stock";
  }

  function fillSizeFilter() {
    var cur = el.fSize.value;
    var sizes = {};
    tapes.forEach(function (t) { sizes[t.size] = true; });
    var list = Object.keys(sizes).sort();
    el.fSize.innerHTML = "<option>All</option>" + list.map(function (s) {
      return "<option>" + esc(s) + "</option>";
    }).join("");
    el.fSize.value = list.indexOf(cur) !== -1 ? cur : "All";
  }

  // The search looks through EVERY tape, not just the page you are on
  function visible() {
    var q = query();
    var dupN = {}, exactN = {};
    tapes.forEach(function (t) {
      var k = dupKey(t), e = k + "|" + Number(t.quantity);
      dupN[k] = (dupN[k] || 0) + 1; exactN[e] = (exactN[e] || 0) + 1;
    });
    var list = tapes.filter(function (t) {
      if (el.fDup.value === "Dup" && dupN[dupKey(t)] < 2) return false;
      if (el.fDup.value === "Exact" && exactN[dupKey(t) + "|" + Number(t.quantity)] < 2) return false;
      if (q && String(t.code).toLowerCase().indexOf(q) === -1) return false;
      if (el.fType.value !== "All" && t.type !== el.fType.value) return false;
      if (el.fSize.value !== "All" && t.size !== el.fSize.value) return false;
      if (el.fAvail.value !== "All" && t.available !== el.fAvail.value) return false;
      var n = Number(t.quantity);
      if (el.fStock.value === "Low" && !(n > 0 && n <= LOW_STOCK)) return false;
      if (el.fStock.value === "Out" && n !== 0) return false;
      return true;
    });

    var sort = el.fSort.value;
    list.sort(function (a, b) {
      if (sort === "qtyLow") return a.quantity - b.quantity || byCode(a, b);
      if (sort === "qtyHigh") return b.quantity - a.quantity || byCode(a, b);
      return byCode(a, b) || a.type.localeCompare(b.type) || a.size.localeCompare(b.size);
    });
    return list;
  }

  function markMatch(code, q) {
    var s = String(code);
    var i = q ? s.toLowerCase().indexOf(q) : -1;
    if (i < 0) return esc(s);
    return esc(s.slice(0, i)) + "<mark>" + esc(s.slice(i, i + q.length)) + "</mark>" + esc(s.slice(i + q.length));
  }

  function pageNumbers(cur, pages) {
    var set = {};
    [1, pages, cur - 1, cur, cur + 1].forEach(function (n) { if (n >= 1 && n <= pages) set[n] = true; });
    var nums = Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
    var out = [], prev = 0;
    nums.forEach(function (n) { if (n - prev > 1) out.push(0); out.push(n); prev = n; });
    return out;
  }

  function renderPager(total, pages, start, shown) {
    if (!total) {
      el.pagerInfo.textContent = "";
      el.pagerNav.innerHTML = "";
      return;
    }
    el.pagerInfo.textContent = "SHOWING " + (start + 1) + "-" + (start + shown) + " OF " + total +
      (pages > 1 ? "  /  PAGE " + page + " OF " + pages : "");

    if (pages <= 1) { el.pagerNav.innerHTML = ""; return; }

    var html = '<button type="button" class="btn" data-page="' + (page - 1) + '"' + (page <= 1 ? " disabled" : "") + ">&lsaquo; PREV</button>";
    pageNumbers(page, pages).forEach(function (n) {
      if (n === 0) html += '<span class="gap pager-num">...</span>';
      else html += '<button type="button" class="btn pager-num' + (n === page ? " on" : "") + '" data-page="' + n + '"' +
        (n === page ? ' aria-current="page"' : "") + ">" + n + "</button>";
    });
    html += '<button type="button" class="btn" data-page="' + (page + 1) + '"' + (page >= pages ? " disabled" : "") + ">NEXT &rsaquo;</button>";
    el.pagerNav.innerHTML = html;
  }

  function renderResultLine(total) {
    var q = el.fSearch.value.trim();
    el.clearSearch.hidden = !q;
    // On a phone the summary tiles and filters are tucked away while searching,
    // so the result and its Edit button show right under the search box
    document.body.classList.toggle("searching", !!q);
    if (!loadedOnce || !tapes.length) { el.resultLine.innerHTML = ""; return; }

    var filtersOn = el.fType.value !== "All" || el.fSize.value !== "All" || el.fAvail.value !== "All" || el.fStock.value !== "All" || el.fDup.value !== "All";
    if (q) {
      el.resultLine.innerHTML = "<span>" + total + (total === 1 ? " RESULT" : " RESULTS") + ' FOR "' + esc(q) + '" (searched all ' + tapes.length + ' tapes)</span>' +
        '<button type="button" class="link-btn" id="showAll">SHOW ALL</button>';
    } else if (filtersOn) {
      el.resultLine.textContent = total + " OF " + tapes.length + " TAPES MATCH THE FILTERS";
    } else {
      el.resultLine.textContent = tapes.length + " TAPES";
    }
  }

  function renderTable() {
    var q = query();
    var list = visible();
    var total = list.length;
    var pages = Math.max(1, Math.ceil(total / pageSize));

    // Just added or edited: go straight to the page where it is
    if (jump && touchedId) {
      var at = list.findIndex(function (t) { return t.id === touchedId; });
      if (at >= 0) page = Math.floor(at / pageSize) + 1;
    }
    if (page > pages) page = pages;
    if (page < 1) page = 1;

    var start = (page - 1) * pageSize;
    var slice = list.slice(start, start + pageSize);

    var dups = {};
    tapes.forEach(function (t) { var k = dupKey(t); dups[k] = (dups[k] || 0) + 1; });

    el.body.innerHTML = slice.map(function (t) {
      var n = Number(t.quantity);
      var tag = n === 0 ? '<span class="tag tag-solid">OUT</span>'
        : (n <= LOW_STOCK ? '<span class="tag tag-line">LOW</span>' : "");
      var note = [];
      if (dups[dupKey(t)] > 1) note.push("Duplicate code, type and size");
      if (t.notes) note.push(esc(t.notes));
      var id = esc(t.id);
      return '<tr data-id="' + id + '">' +
        '<td class="c-code"><span class="id-cell" title="ID">' + (t.num ? "#" + t.num : "NEW") + '</span><span class="code-cell">' + markMatch(t.code, q) + "</span>" +
          (pending[t.id] ? '<span class="pend" title="Waiting to sync"></span>' : "") +
          (note.length ? '<span class="sub-note">' + note.join(" / ") + "</span>" : "") + "</td>" +
        '<td class="c-type" data-label="Type">' + esc(t.type) + "</td>" +
        '<td class="c-size" data-label="Size">' + esc(t.size) + "</td>" +
        '<td class="c-qty num"><span class="qty-cell">' + n + "</span>" + tag + "</td>" +
        '<td class="c-avail" data-label="Available"><span class="tag ' + (t.available === "Yes" ? "tag-line" : "tag-solid") + '">' +
          (t.available === "Yes" ? "YES" : "NO") + "</span></td>" +
        '<td class="c-act act-col"><div class="row-actions">' +
          '<button type="button" class="btn btn-step" data-act="minus" data-id="' + id + '" aria-label="Take out"' + (n === 0 ? " disabled" : "") + ">-</button>" +
          '<button type="button" class="btn btn-step" data-act="plus" data-id="' + id + '" aria-label="Add in">+</button>' +
          '<button type="button" class="btn" data-act="edit" data-id="' + id + '">EDIT</button>' +
          '<button type="button" class="btn" data-act="delete" data-id="' + id + '">DELETE</button>' +
        "</div></td></tr>";
    }).join("");

    if (!loadedOnce) {
      el.empty.textContent = "LOADING...";
      el.empty.hidden = false;
    } else if (!tapes.length) {
      el.empty.textContent = lastSync
        ? "NO TAPES YET. USE + ADD NEW TAPE"
        : (navigator.onLine ? "DOWNLOADING YOUR INVENTORY..." : "CONNECT TO THE INTERNET ONCE TO DOWNLOAD YOUR INVENTORY");
      el.empty.hidden = false;
    } else if (!total) {
      el.empty.textContent = q ? 'NO TAPE WITH CODE "' + el.fSearch.value.trim().toUpperCase() + '"' : "NO TAPES MATCH THESE FILTERS";
      el.empty.hidden = false;
    } else {
      el.empty.hidden = true;
    }

    renderPager(total, pages, start, slice.length);
    renderResultLine(total);

    if (jump && touchedId) {
      var row = el.body.querySelector('tr[data-id="' + touchedId + '"]');
      if (row) {
        row.classList.add("flash");
        row.scrollIntoView({ block: "center" });
      }
      jump = false;
      touchedId = null;
    }
  }

  function renderAll() {
    renderStatus();
    renderStats();
    fillSizeFilter();
    renderTable();
  }

  // ---------- Search and filters ----------
  function onSearch() { page = 1; renderTable(); }

  // Redraw only while typing. Listening to "change" as well would redraw the table when the
  // box loses focus, which swallows the first click on a row button.
  el.fSearch.addEventListener("input", onSearch);
  el.fSearch.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && el.fSearch.value) { el.fSearch.value = ""; onSearch(); }
  });
  el.clearSearch.addEventListener("click", function () { el.fSearch.value = ""; onSearch(); el.fSearch.focus(); });
  el.resultLine.addEventListener("click", function (e) {
    if (e.target.id === "showAll") { el.fSearch.value = ""; onSearch(); }
  });

  [el.fType, el.fSize, el.fAvail, el.fStock, el.fDup, el.fSort].forEach(function (c) {
    c.addEventListener("change", function () { page = 1; renderTable(); });
  });
  el.pageSize.addEventListener("change", function () {
    pageSize = Number(el.pageSize.value) || 25;
    page = 1;
    renderTable();
  });

  // Press "/" anywhere to jump to the search box
  document.addEventListener("keydown", function (e) {
    if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
    var tag = (document.activeElement && document.activeElement.tagName) || "";
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(tag) || document.querySelector("dialog[open]")) return;
    e.preventDefault();
    el.fSearch.focus();
    el.fSearch.select();
  });

  el.pagerNav.addEventListener("click", function (e) {
    var b = e.target.closest("button[data-page]");
    if (!b || b.disabled) return;
    page = Number(b.getAttribute("data-page"));
    renderTable();
    $("tapeTable").parentNode.scrollIntoView({ block: "start" });
  });

  // ---------- Sync (runs in a separate thread) ----------
  var worker = null;
  var syncTimer = null;

  try {
    worker = new Worker("sync-worker.js");
    worker.onmessage = function (e) {
      var m = e.data || {};
      if (m.type === "state") {
        syncing = true;
        renderStatus();
      } else if (m.type === "done") {
        syncing = false;
        authLost = false;
        if (m.rejected) {
          el.rejectBanner.textContent = m.rejected + " change(s) were refused by the server (invalid data) and removed.";
          el.rejectBanner.hidden = false;
        }
        refresh();
      } else if (m.type === "error") {
        syncing = false;
        if (m.auth) authLost = true;
        refresh();
      }
    };
    worker.onerror = function () { syncing = false; renderStatus(); };
  } catch (e) {
    worker = null;
  }

  function requestSync(delay) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(function () {
      if (!worker || !navigator.onLine || authLost) return;
      worker.postMessage({ type: "sync", api: API, token: getToken() });
    }, delay == null ? 300 : delay);
  }

  window.addEventListener("online", function () { renderStatus(); requestSync(0); });
  window.addEventListener("offline", function () { renderStatus(); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") requestSync(0);
  });
  setInterval(function () {
    if (document.visibilityState === "visible") requestSync(0);
    renderStatus();
  }, 60000);

  el.syncBtn.addEventListener("click", function () { requestSync(0); });

  // ---------- Offline app (service worker) ----------
  (function showAppState() {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) {
      el.appState.textContent = "Offline app: needs HTTPS";
      return;
    }
    navigator.serviceWorker.register("sw.js").then(function () {
      return navigator.serviceWorker.ready;
    }).then(function () {
      el.appState.textContent = "Offline app: ready";
    }).catch(function () {
      el.appState.textContent = "Offline app: not available";
    });
  })();

  // ---------- Add / Edit pop-up ----------
  function dlgError(text, focusEl) {
    el.dlgMsg.textContent = text;
    el.dlgMsg.hidden = false;
    if (focusEl) focusEl.focus();
  }

  function clearDlgError() { el.dlgMsg.hidden = true; el.dlgMsg.textContent = ""; }

  function openTape(id) {
    clearDlgError();
    el.dlgSave.disabled = false;
    el.form.reset();
    el.tId.value = "";
    el.tSize.value = "1*20";
    el.tQty.value = "0";

    if (!id) {
      el.dlgTitle.textContent = "ADD NEW TAPE";
      el.dlgSave.textContent = "ADD TAPE";
      // Searched a code that does not exist? Start the new tape with it.
      var raw = el.fSearch.value.trim();
      if (raw && raw.length <= 30 && visible().length === 0) el.tCode.value = raw;
    } else {
      var t = tapes.find(function (x) { return x.id === id; });
      if (!t) return;
      el.tId.value = t.id;
      el.tCode.value = t.code;
      el.tType.value = t.type;
      el.tSize.value = t.size;
      el.tQty.value = t.quantity;
      el.tAvail.value = t.available;
      el.tNotes.value = t.notes || "";
      el.dlgTitle.textContent = "EDIT TAPE";
      el.dlgSave.textContent = "SAVE CHANGES";
    }
    openDlg(el.dlg);
    (id ? el.tQty : el.tCode).focus();
    (id ? el.tQty : el.tCode).select();
  }

  function closeTape() { closeDlg(el.dlg); }

  el.addBtn.addEventListener("click", function () { openTape(null); });
  el.dlgCancel.addEventListener("click", closeTape);
  el.dlgClose.addEventListener("click", closeTape);
  el.dlg.addEventListener("close", clearDlgError);

  el.form.addEventListener("submit", function (ev) {
    ev.preventDefault();

    var f = {
      code: el.tCode.value.trim(),
      type: el.tType.value,
      size: el.tSize.value.trim(),
      available: el.tAvail.value,
      notes: el.tNotes.value.trim()
    };
    var qtyText = el.tQty.value.trim();
    var qty = Number(qtyText);

    if (!f.code) return dlgError("Enter the tape code.", el.tCode);
    if (!f.size) return dlgError("Enter the size, for example 1*20.", el.tSize);
    if (qtyText === "" || !Number.isInteger(qty) || qty < 0) return dlgError("Quantity must be a whole number, 0 or more.", el.tQty);

    var id = el.tId.value;

    if (!id) {
      var exact = tapes.filter(function (t) {
        return String(t.code).trim().toLowerCase() === f.code.toLowerCase() &&
          Number(t.quantity) === qty &&
          String(t.size).trim().toLowerCase() === f.size.toLowerCase() &&
          t.type === f.type;
      });
      if (exact.length) {
        // everything is the same as an existing row: warn, do not add
        showToast("Already added: code " + f.code + ", " + qty + " rolls, " + f.size + ", " + f.type + ".");
        return;
      }
      f.quantity = qty;
      var newId = uuid();
      touchedId = newId; jump = true;
      el.dlgSave.disabled = true;
      commit([makeOp("create", newId, { fields: f })]).then(closeTape);
      return;
    }

    var old = tapes.find(function (x) { return x.id === id; });
    if (!old) { closeTape(); return; }

    var ops = [];
    var changed = {};
    ["code", "type", "size", "available", "notes"].forEach(function (k) {
      if (String(old[k] || "") !== String(f[k] || "")) changed[k] = f[k];
    });
    if (Object.keys(changed).length) ops.push(makeOp("update", id, { fields: changed }));
    if (qty !== Number(old.quantity)) ops.push(makeOp("adjust", id, { delta: qty - Number(old.quantity) }));

    if (!ops.length) { closeTape(); return; }
    touchedId = id; jump = true;
    el.dlgSave.disabled = true;
    commit(ops).then(closeTape);
  });

  // ---------- Row buttons ----------
  el.body.addEventListener("click", function (ev) {
    var btn = ev.target.closest("button[data-act]");
    if (!btn || btn.disabled) return;
    var id = btn.getAttribute("data-id");
    var act = btn.getAttribute("data-act");
    var step = Number(el.fStep.value) || 1;
    var t = tapes.find(function (x) { return x.id === id; });
    if (!t) return;

    if (act === "plus") commit([makeOp("adjust", id, { delta: step })]);
    else if (act === "minus") {
      var d = Math.min(step, Number(t.quantity));
      if (d > 0) commit([makeOp("adjust", id, { delta: -d })]);
    } else if (act === "edit") openTape(id);
    else if (act === "delete") {
      askConfirm("DELETE TAPE", "Delete code " + t.code + " (" + t.type + ", " + t.size + ", " + t.quantity + " rolls)?", "DELETE")
        .then(function (yes) { if (yes) commit([makeOp("delete", id)]); });
    }
  });

  // ---------- Export ----------
  $("exportBtn").addEventListener("click", function () {
    var list = visible();
    if (!list.length) { askConfirm("NOTHING TO EXPORT", "There are no rows in the current view.", "OK"); return; }
    var cell = function (v) { return '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"'; };
    var rows = [["Code", "Quantity", "Type", "Available", "Size", "Notes"]];
    list.forEach(function (t) { rows.push([t.code, t.quantity, t.type, t.available, t.size, t.notes || ""]); });
    var csv = rows.map(function (r) { return r.map(cell).join(","); }).join("\r\n");
    var url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    var a = document.createElement("a");
    a.href = url;
    a.download = "edge-tapes-" + new Date().toISOString().slice(0, 10) + ".csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  // ---------- Logout ----------
  el.logoutBtn.addEventListener("click", function () {
    var go = pendingCount > 0
      ? askConfirm("LOG OUT?", pendingCount + " change(s) have not been synced yet and will be LOST if you log out.", "LOG OUT ANYWAY")
      : Promise.resolve(true);

    go.then(function (yes) {
      if (!yes) return;
      var finish = function () {
        try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
        var back = function () { location.replace("login.html"); };
        TapesDB.clearAll().then(back, back);
      };
      if (!navigator.onLine) return finish();
      fetch(API + "/api/logout", { method: "POST", headers: { Authorization: "Bearer " + getToken() } })
        .then(finish, finish);
    });
  });

  // ---------- Start ----------
  renderAll();
  refresh().then(function () { requestSync(0); });
})();
