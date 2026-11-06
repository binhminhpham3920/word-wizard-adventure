/* Cloud save shared by Word Wizard (/) and Word Muncher (/muncher/).
   Keeps iPhone and iPad on the same progress. Never throws away play history:
   - a device with no unsaved changes simply takes the newer cloud copy;
   - when both devices changed (or a device links for the first time) the two copies are MERGED
     (history lists are unioned, levels/stations/pets keep the furthest, word stats keep the most practised).
   Setup on each device: open the game once with ?sync=<family-code>, or tap the ☁️ badge and type the code. */
(function () {
  var API = "/api/sync", K = { code: "sync.code", rev: "sync.rev", dirty: "sync.dirty", at: "sync.at" };
  var TRACK = /^(word_wizard_|wm\.|snake\.)/, SKIP = { "snake.cfg": 1 };
  var S = window.localStorage; if (!S) return;
  var rawSet = Storage.prototype.setItem, rawRemove = Storage.prototype.removeItem;
  function get(k) { try { return S.getItem(k); } catch (e) { return null; } }
  function put(k, v) { try { rawSet.call(S, k, v); } catch (e) {} }
  function tracked(k) { return TRACK.test(k) && !SKIP[k]; }

  /* mark the device dirty whenever the game really changes a tracked value */
  var frozen = false; /* after the cloud copy is written we reload; block the old in-memory game state from writing back */
  Storage.prototype.setItem = function (k, v) {
    if (frozen && this === S && tracked(k)) return;
    if (this === S && tracked(k) && S.getItem(k) !== String(v)) { rawSet.call(S, K.dirty, "1"); schedule(); }
    return rawSet.call(this, k, v);
  };
  Storage.prototype.removeItem = function (k) {
    if (frozen && this === S && tracked(k)) return;
    if (this === S && tracked(k) && S.getItem(k) !== null) { rawSet.call(S, K.dirty, "1"); schedule(); }
    return rawRemove.call(this, k);
  };

  var q = new URLSearchParams(location.search).get("sync");
  if (q && /^[a-z0-9-]{6,40}$/i.test(q)) { put(K.code, q.toLowerCase()); put(K.rev, ""); history.replaceState(null, "", location.pathname + location.hash); }
  function code() { return get(K.code); }

  function snapshot() { var d = {}; for (var i = 0; i < S.length; i++) { var k = S.key(i); if (tracked(k)) d[k] = S.getItem(k); } return d; }
  function apply(d) { /* write cloud copy into this device; returns true if anything changed */
    var changed = false;
    Object.keys(d).forEach(function (k) { if (tracked(k) && S.getItem(k) !== d[k]) { put(k, d[k]); changed = true; } });
    return changed;
  }

  /* ---------- merge (used only when both sides changed, or on first link) ---------- */
  function J(s, def) { try { var v = JSON.parse(s); return v == null ? def : v; } catch (e) { return def; } }
  function num(s) { var n = parseFloat(s); return isNaN(n) ? 0 : n; }
  function union(a, b) { var out = (a || []).slice(); (b || []).forEach(function (x) { if (out.indexOf(x) < 0) out.push(x); }); return out; }
  function merge(L, C) {
    var M = {}, keys = union(Object.keys(L), Object.keys(C));
    keys.forEach(function (k) {
      var l = L[k], c = C[k];
      if (l == null) { M[k] = c; return; } if (c == null) { M[k] = l; return; }
      var r = l;
      switch (k) {
        case "snake.games": { var seen = {}, all = J(c, []).concat(J(l, [])).filter(function (g) { if (!g || seen[g.id]) return false; seen[g.id] = 1; return true; });
          all.sort(function (a, b) { return a.ts - b.ts; }); r = JSON.stringify(all); break; }
        case "wm.mastery": { var a = J(l, {}), b = J(c, {}); Object.keys(b).forEach(function (w) { var x = a[w], y = b[w]; if (!x || ((y.ok || 0) + (y.bad || 0)) > ((x.ok || 0) + (x.bad || 0))) a[w] = y; }); r = JSON.stringify(a); break; }
        case "wm.prog": { var a = J(l, {}), b = J(c, {}); var o = { unlocked: Math.max(a.unlocked || 0, b.unlocked || 0) };
          var ca = a.cp, cb = b.cp; o.cp = !ca ? cb : !cb ? ca : (cb.level > ca.level || (cb.level === ca.level && cb.boss && !ca.boss)) ? cb : ca;
          if (!o.cp) delete o.cp; r = JSON.stringify(o); break; }
        case "snake.best2": { var a = J(l, {}), b = J(c, {}); r = JSON.stringify({ score: Math.max(a.score || 0, b.score || 0), level: Math.max(a.level || 1, b.level || 1) }); break; }
        case "wm.gems": { var a = J(l, {}), b = J(c, {}); r = JSON.stringify(a.d === b.d ? { d: a.d, n: Math.max(a.n || 0, b.n || 0) } : (a.d > b.d ? a : b)); break; }
        case "word_wizard_stars": case "word_wizard_streak": case "word_wizard_peeks": case "word_wizard_q_index":
          r = String(Math.max(num(l), num(c))); break;
        case "word_wizard_pets": case "word_wizard_discovered": case "word_wizard_rewarded": case "word_wizard_stations":
          r = JSON.stringify(union(J(l, []), J(c, []))); break;
        case "word_wizard_inventory": { var a = J(l, {}), b = J(c, {}); Object.keys(b).forEach(function (n) { a[n] = Math.max(a[n] || 0, b[n] || 0); }); r = JSON.stringify(a); break; }
        case "word_wizard_results": { var a = J(c, {}), b = J(l, {}); Object.keys(b).forEach(function (id) { a[id] = b[id]; }); r = JSON.stringify(a); break; }
        default: r = l;
      }
      M[k] = r;
    });
    if (M.word_wizard_pending) { /* keep reviews still owed, drop ones already answered on either device */
      var done = J(M.word_wizard_rewarded, []), seen = {};
      var p = J(L.word_wizard_pending, []).concat(J(C.word_wizard_pending, [])).filter(function (x) { if (!x || seen[x.id] || done.indexOf(x.id) >= 0) return false; seen[x.id] = 1; return true; });
      M.word_wizard_pending = JSON.stringify(p);
    }
    return M;
  }

  /* ---------- network ---------- */
  var busy = false, timer = null, state = "off";
  function setState(s) { state = s; paint(); }
  function schedule() { if (!code()) return; clearTimeout(timer); timer = setTimeout(push, 2500); }
  function reloadOnce(rev) { var g = "sync.reloaded." + rev; try { if (sessionStorage.getItem(g)) return; sessionStorage.setItem(g, "1"); } catch (e) {} frozen = true; location.reload(); }

  function push(keepalive) {
    if (!code() || busy || frozen) return Promise.resolve();
    if (get(K.dirty) !== "1" && get(K.rev)) return Promise.resolve();
    var body = JSON.stringify({ code: code(), baseRev: parseInt(get(K.rev) || "0", 10) || 0, data: snapshot() });
    var ka = !!keepalive && body.length < 60000;
    busy = true; setState("busy");
    return fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: body, keepalive: ka })
      .then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
      .then(function (x) {
        busy = false;
        if (x.s === 200) { put(K.rev, String(x.j.rev)); put(K.dirty, "0"); put(K.at, String(Date.now())); setState("ok"); return; }
        if (x.s === 409) return resolve(x.j);   /* another device saved first: merge, then save */
        setState(x.s === 503 ? "nostore" : "err");
      }).catch(function () { busy = false; setState("err"); });
  }

  function resolve(doc) { /* doc = cloud {rev,data} newer than what this device last saw */
    var local = snapshot(), localRev = get(K.rev), dirty = get(K.dirty) === "1";
    var mustMerge = !localRev || dirty;
    var target = mustMerge ? merge(local, doc.data || {}) : doc.data || {};
    var changed = apply(target);
    put(K.rev, String(doc.rev));
    if (mustMerge && JSON.stringify(target) !== JSON.stringify(doc.data || {})) { put(K.dirty, "1"); busy = false; return push().then(function () { if (changed) reloadOnce(doc.rev + "m"); }); }
    put(K.dirty, "0"); put(K.at, String(Date.now())); setState("ok");
    if (changed) reloadOnce(doc.rev);
  }

  function pull() {
    if (!code() || busy) return;
    setState("busy");
    fetch(API + "?code=" + encodeURIComponent(code()), { cache: "no-store" })
      .then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
      .then(function (x) {
        if (x.s !== 200) { setState(x.s === 503 ? "nostore" : "err"); return; }
        var doc = x.j, localRev = parseInt(get(K.rev) || "0", 10) || 0;
        if (!doc.rev) { put(K.dirty, "1"); return push(); }                       /* cloud empty: upload this device */
        if (get(K.rev) && doc.rev === localRev) { if (get(K.dirty) === "1") return push(); setState("ok"); return; }
        resolve(doc);
      }).catch(function () { setState("err"); });
  }

  /* ---------- tiny ☁️ badge (bottom-left) ---------- */
  var badge = null;
  function paint() {
    if (!badge) return;
    var m = { off: ["☁️", "#ccc"], busy: ["☁️…", "#FFD166"], ok: ["☁️✓", "#7BD389"], err: ["☁️!", "#F4A261"], nostore: ["☁️?", "#F4A261"] }[code() ? state : "off"];
    badge.textContent = m[0]; badge.style.borderColor = m[1];
  }
  function mountBadge() {
    badge = document.createElement("button"); badge.type = "button"; badge.setAttribute("aria-label", "Cloud save");
    badge.style.cssText = "position:fixed;left:8px;bottom:calc(8px + env(safe-area-inset-bottom));z-index:99999;font:600 12px system-ui,sans-serif;padding:4px 8px;border-radius:12px;border:2px solid #ccc;background:rgba(255,255,255,.85);color:#333;opacity:.75";
    badge.onclick = function () {
      var at = get(K.at), msg = code()
        ? "Cloud save is ON (code: " + code() + ")" + (at ? "\nLast saved: " + new Date(+at).toLocaleString("vi-VN") : "") + (state === "nostore" ? "\n⚠️ Storage not connected in Vercel yet." : state === "err" ? "\n⚠️ Offline – will retry." : "") + "\n\nParents: type a new code to change it, or leave as is."
        : "Parents: type the family code to sync iPhone and iPad (6+ letters/numbers).";
      var v = prompt(msg, code() || "");
      if (v == null) return; v = v.trim().toLowerCase();
      if (v && v !== code()) { if (!/^[a-z0-9-]{6,40}$/.test(v)) { alert("Code needs 6–40 letters, numbers or -"); return; } put(K.code, v); put(K.rev, ""); pull(); }
    };
    document.body.appendChild(badge); paint();
  }
  if (document.body) mountBadge(); else document.addEventListener("DOMContentLoaded", mountBadge);

  document.addEventListener("visibilitychange", function () { if (document.hidden) push(true); else pull(); });
  window.addEventListener("pagehide", function () { push(true); });
  window.addEventListener("online", pull);
  pull();
  window.__sync = { pull: pull, push: push, merge: merge, snapshot: snapshot };
})();
