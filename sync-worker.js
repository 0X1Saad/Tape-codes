// Background thread that syncs the tapes inventory with the server.
// It runs separately from the page, so the screen never freezes while syncing.
"use strict";
importScripts("db.js");

var cfg = null;
var running = false;
var again = false;

self.onmessage = function (e) {
  var m = e.data || {};
  if (m.type === "sync") {
    cfg = { api: m.api, token: m.token };
    start();
  }
};

function post(msg) { self.postMessage(msg); }

function start() {
  if (running) { again = true; return; }
  running = true;
  again = false;
  post({ type: "state", state: "syncing" });

  cycle().then(
    function (r) { post({ type: "done", pulled: r.pulled, sent: r.sent, rejected: r.rejected }); },
    function (err) {
      post({ type: "error", auth: !!(err && err.auth), message: String((err && err.message) || err) });
    }
  ).then(function () {
    running = false;
    if (again) start();
  });
}

function strip(o) {
  return { opId: o.opId, type: o.type, id: o.id, fields: o.fields, delta: o.delta };
}

async function cycle() {
  var sent = 0, pulled = 0, rejected = 0, loops = 0;

  while (loops++ < 40) {
    var outbox = await TapesDB.getOutbox(50);
    var since = (await TapesDB.getMeta("cursor")) || 0;

    var res = await fetch(cfg.api + "/api/tapes/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.token },
      body: JSON.stringify({ since: since, ops: outbox.map(strip) })
    });

    if (res.status === 401) {
      var a = new Error("Session expired");
      a.auth = true;
      throw a;
    }
    if (!res.ok) throw new Error("Server error " + res.status);

    var data = await res.json();
    await TapesDB.applySync(outbox.map(function (o) { return o.seq; }), data);

    sent += outbox.length;
    pulled += (data.changes || []).length;
    rejected += (data.rejected || []).length;

    var left = await TapesDB.countOutbox();
    var moreToSend = left > 0 && outbox.length > 0;
    if (!data.more && !moreToSend) break;
  }
  return { sent: sent, pulled: pulled, rejected: rejected };
}
