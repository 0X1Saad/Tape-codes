(function () {
  "use strict";

  var TOKEN_KEY = "edge_tapes_token";
  var API = ((window.APP_CONFIG && window.APP_CONFIG.API_URL) || "").replace(/\/+$/, "");

  var form = document.getElementById("loginForm");
  var userEl = document.getElementById("username");
  var passEl = document.getElementById("password");
  var msgEl = document.getElementById("msg");
  var btn = document.getElementById("loginBtn");

  // Already signed in on this device
  try {
    if (localStorage.getItem(TOKEN_KEY)) {
      location.replace("index.html");
      return;
    }
  } catch (e) {}

  function showMsg(text) {
    msgEl.textContent = text;
    msgEl.hidden = !text;
  }

  function setBusy(busy) {
    btn.disabled = busy;
    btn.textContent = busy ? "CHECKING..." : "LOGIN";
  }

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    showMsg("");

    var user = userEl.value.trim();
    var pass = passEl.value;
    if (!user || !pass) return showMsg("Enter your username and password.");

    setBusy(true);

    fetch(API + "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: user, password: pass })
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          return { ok: r.ok, data: d };
        });
      })
      .then(function (res) {
        if (res.ok && res.data.token) {
          try {
            localStorage.setItem(TOKEN_KEY, res.data.token);
          } catch (e) {
            setBusy(false);
            return showMsg("This browser blocked saving the sign-in.");
          }
          location.replace("index.html");
          return;
        }
        setBusy(false);
        passEl.value = "";
        passEl.focus();
        showMsg(res.data.error || "Login failed.");
      })
      .catch(function () {
        setBusy(false);
        showMsg("Cannot reach the server. Check your internet and try again.");
      });
  });
})();
