// Local database for the tapes inventory (IndexedDB).
// Used by the page AND by the background sync worker, so it only uses `self`.
(function (g) {
  "use strict";

  var NAME = "tapes_inventory_v1";
  var dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise(function (resolve, reject) {
        var r = indexedDB.open(NAME, 1);
        r.onupgradeneeded = function () {
          var db = r.result;
          db.createObjectStore("tapes", { keyPath: "id" });
          db.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true });
          db.createObjectStore("meta", { keyPath: "key" });
        };
        r.onsuccess = function () {
          var db = r.result;
          db.onversionchange = function () { db.close(); dbPromise = null; };
          resolve(db);
        };
        r.onerror = function () { dbPromise = null; reject(r.error); };
      });
    }
    return dbPromise;
  }

  // Runs `work(transaction, setResult)` and resolves with the result when the transaction is complete
  function run(stores, mode, work) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(stores, mode);
        var result;
        t.oncomplete = function () { resolve(result); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error("Database transaction aborted")); };
        work(t, function (v) { result = v; });
      });
    });
  }

  function getAll() {
    return run(["tapes"], "readonly", function (t, set) {
      var q = t.objectStore("tapes").getAll();
      q.onsuccess = function () { set(q.result || []); };
    });
  }

  function getOutbox(limit) {
    return run(["outbox"], "readonly", function (t, set) {
      var q = t.objectStore("outbox").getAll(null, limit || undefined);
      q.onsuccess = function () { set(q.result || []); };
    });
  }

  function countOutbox() {
    return run(["outbox"], "readonly", function (t, set) {
      var q = t.objectStore("outbox").count();
      q.onsuccess = function () { set(q.result || 0); };
    });
  }

  // ids of tapes that have changes waiting to be sent
  function getPendingIds() {
    return getOutbox().then(function (list) {
      var ids = {};
      list.forEach(function (o) { ids[o.id] = true; });
      return ids;
    });
  }

  function getMeta(key) {
    return run(["meta"], "readonly", function (t, set) {
      var q = t.objectStore("meta").get(key);
      q.onsuccess = function () { set(q.result ? q.result.value : undefined); };
    });
  }

  function setMeta(key, value) {
    return run(["meta"], "readwrite", function (t) {
      t.objectStore("meta").put({ key: key, value: value });
    });
  }

  // Apply changes made on THIS device: update the local copy and queue them for sync
  function applyLocal(ops) {
    return run(["tapes", "outbox"], "readwrite", function (t) {
      var tapes = t.objectStore("tapes");
      var outbox = t.objectStore("outbox");
      var i = 0;

      function next() {
        if (i >= ops.length) return;
        var op = ops[i++];

        if (op.type === "create") {
          var row = { id: op.id };
          Object.keys(op.fields).forEach(function (k) { row[k] = op.fields[k]; });
          tapes.put(row);
          outbox.add(op);
          next();
          return;
        }

        var g = tapes.get(op.id);
        g.onsuccess = function () {
          var cur = g.result;
          if (cur) {
            if (op.type === "update") {
              Object.keys(op.fields).forEach(function (k) { cur[k] = op.fields[k]; });
              tapes.put(cur);
            } else if (op.type === "adjust") {
              cur.quantity = Math.max(0, Number(cur.quantity) + Number(op.delta));
              tapes.put(cur);
            } else if (op.type === "delete") {
              tapes.delete(op.id);
            }
          }
          outbox.add(op);
          next();
        };
      }
      next();
    });
  }

  // Store what the server answered: drop the sent operations, merge the server's changes
  function applySync(sentKeys, data) {
    return run(["tapes", "outbox", "meta"], "readwrite", function (t) {
      var tapes = t.objectStore("tapes");
      var outbox = t.objectStore("outbox");
      var meta = t.objectStore("meta");

      sentKeys.forEach(function (k) { outbox.delete(k); });

      var rest = outbox.getAll();
      rest.onsuccess = function () {
        var pending = {};
        (rest.result || []).forEach(function (o) { pending[o.id] = true; });

        (data.changes || []).forEach(function (c) {
          // A newer change made on this device is still waiting: keep it, the next sync reconciles
          if (pending[c.id]) return;
          if (c.deleted) {
            tapes.delete(c.id);
          } else {
            tapes.put({
              id: c.id, code: c.code, quantity: c.quantity, type: c.type,
              available: c.available, size: c.size, notes: c.notes || "", num: c.num || 0
            });
          }
        });

        meta.put({ key: "cursor", value: data.cursor });
        meta.put({ key: "lastSync", value: Date.now() });
      };
    });
  }

  function clearAll() {
    return run(["tapes", "outbox", "meta"], "readwrite", function (t) {
      t.objectStore("tapes").clear();
      t.objectStore("outbox").clear();
      t.objectStore("meta").clear();
    });
  }

  g.TapesDB = {
    getAll: getAll,
    getOutbox: getOutbox,
    countOutbox: countOutbox,
    getPendingIds: getPendingIds,
    getMeta: getMeta,
    setMeta: setMeta,
    applyLocal: applyLocal,
    applySync: applySync,
    clearAll: clearAll
  };
})(self);
