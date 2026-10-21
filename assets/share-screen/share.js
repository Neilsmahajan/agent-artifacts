// The Share screen. Talks only to /_share/api/ on this origin; the helper
// re-checks everything (owner login, rule shapes), so this file is just UI.
(function () {
  "use strict";

  var state = null;
  var current = null;
  var $ = function (id) { return document.getElementById(id); };

  function setStatus(text, isError) {
    $("status").textContent = text || "";
    $("status").className = isError ? "error" : "";
  }

  // The helper wants its token twice: in the hub_share cookie (scoped to
  // /_share/, so only this screen can read it) and echoed in a header. POST
  // session mints it; a "share-token" refusal means it expired, so mint a new
  // one and retry once.
  function token() {
    var match = document.cookie.match(/(?:^|;\s*)hub_share=([0-9]+\.[A-Za-z0-9_-]+)/);
    return match ? match[1] : "";
  }

  var session = null;
  function ensureSession(fresh) {
    if (!fresh && token()) return Promise.resolve();
    if (!session || fresh) {
      session = send("POST", "session", {}).then(
        function () { session = null; },
        function (error) { session = null; throw error; },
      );
    }
    return session;
  }

  function send(method, action, body) {
    var headers = { "X-Share-Screen": "1" };
    if (method !== "GET") headers["Content-Type"] = "application/json";
    if (action !== "session") headers["X-Share-Token"] = token();
    return fetch("/_share/api/" + action, {
      method: method,
      credentials: "same-origin",
      headers: headers,
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var detail = data.problems && data.problems.length ? " — " + data.problems.join("; ") : "";
          var error = new Error((data.error || "Request failed (" + res.status + ")") + detail);
          error.code = data.code;
          throw error;
        }
        return data;
      });
    });
  }

  function api(method, action, body) {
    return ensureSession(false)
      .then(function () { return send(method, action, body); })
      .catch(function (error) {
        if (error.code !== "share-token") throw error;
        return ensureSession(true).then(function () { return send(method, action, body); });
      });
  }

  function busy(on) {
    Array.prototype.forEach.call(document.querySelectorAll("#detail button"), function (b) { b.disabled = on; });
  }

  function run(label, promise) {
    busy(true);
    setStatus(label + "…");
    return promise.then(function (result) {
      busy(false);
      return result;
    }, function (error) {
      busy(false);
      setStatus(error.message, true);
      throw error;
    });
  }

  function pageUrl(slug) { return "https://" + state.host + "/" + slug + "/"; }
  function linkUrl(code) { return "https://" + state.host + "/_link/" + code + "/"; }

  function load() {
    return api("GET", "state").then(function (data) {
      state = data;
      if (!data.linkRule) data.problems.push("The /_link rule is missing, so links ask for a login (share.mjs setup-link-rule).");
      var problems = $("problems");
      problems.textContent = "";
      problems.hidden = !data.problems.length;
      data.problems.forEach(function (p) {
        var li = document.createElement("li");
        li.textContent = p;
        problems.appendChild(li);
      });
      renderList();
      var fromHash = decodeURIComponent(location.hash.slice(1));
      if (fromHash && data.pages[fromHash]) select(fromHash);
      else if (current) select(current);
      setStatus("");
    }).catch(function (error) { setStatus(error.message, true); });
  }

  function renderList() {
    var terms = $("search").value.toLowerCase().split(/\s+/).filter(Boolean);
    var list = $("pages");
    list.textContent = "";
    var slugs = Object.keys(state.pages).sort(function (a, b) {
      var sa = isShared(a) ? 1 : 0, sb = isShared(b) ? 1 : 0;
      if (sa !== sb) return sb - sa;
      return String(state.pages[b].updated || "").localeCompare(String(state.pages[a].updated || ""));
    });
    slugs.forEach(function (slug) {
      var page = state.pages[slug];
      var hay = (slug + " " + (page.title || "") + " " + (page.project || "")).toLowerCase();
      if (!terms.every(function (t) { return hay.indexOf(t) !== -1; })) return;
      var li = document.createElement("li");
      li.setAttribute("aria-current", String(slug === current));
      var button = document.createElement("button");
      button.type = "button";
      var title = document.createElement("span");
      title.className = "page-title";
      title.textContent = page.title || slug;
      var guests = state.shares[slug] || [];
      if (guests.length) title.appendChild(badge(guests.length + (guests.length === 1 ? " person" : " people")));
      if (state.links[slug]) title.appendChild(badge("link on"));
      var meta = document.createElement("span");
      meta.className = "page-meta";
      meta.textContent = [page.project, page.lifecycle !== "active" ? page.lifecycle : "", page.updated].filter(Boolean).join(" · ");
      button.appendChild(title);
      button.appendChild(meta);
      button.addEventListener("click", function () { select(slug); });
      li.appendChild(button);
      list.appendChild(li);
    });
  }

  function badge(text) {
    var span = document.createElement("span");
    span.className = "badge";
    span.textContent = text;
    return span;
  }

  function isShared(slug) { return (state.shares[slug] || []).length > 0 || Boolean(state.links[slug]); }

  function select(slug) {
    current = slug;
    if (location.hash.slice(1) !== slug) history.replaceState(null, "", "#" + encodeURIComponent(slug));
    var page = state.pages[slug];
    $("detail").hidden = false;
    $("title").textContent = page.title || slug;
    $("slug").textContent = "/" + slug + "/";
    $("open-page").href = pageUrl(slug);

    var warnings = $("warnings");
    warnings.textContent = "";
    var priv = (page.linksTo || []).filter(function (s) { return !isShared(s); });
    if (priv.length) warn("Links to " + priv.length + " of your other pages (" + priv.map(function (s) { return state.pages[s] ? state.pages[s].title : s; }).join(", ") + "). Guests can read those titles but can't open them.");
    if (page.supersededBy) warn("This page is superseded by " + page.supersededBy + ". Guests of this page can't open the replacement unless you share it too.");
    if (page.lifecycle === "archived") warn("This page is archived.");

    var guests = state.shares[slug] || [];
    var ul = $("guests");
    ul.textContent = "";
    if (!guests.length) {
      var none = document.createElement("li");
      none.className = "none";
      none.textContent = "Not shared with anyone.";
      ul.appendChild(none);
    }
    guests.forEach(function (email) {
      var li = document.createElement("li");
      var span = document.createElement("span");
      span.textContent = email;
      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger";
      remove.textContent = "Remove";
      remove.addEventListener("click", function () { unshare(slug, email); });
      li.appendChild(span);
      li.appendChild(remove);
      ul.appendChild(li);
    });

    var needsFiles = page.kind === "static" && !guests.length && !state.links[slug];
    $("files").hidden = !needsFiles;
    $("files-ok").checked = false;
    var fl = $("file-list");
    fl.textContent = "";
    (page.files || []).forEach(function (f) {
      var li = document.createElement("li");
      li.textContent = f;
      fl.appendChild(li);
    });
    $("copy-people").hidden = !guests.length;

    var code = state.links[slug];
    $("link-on").hidden = !code;
    $("link-off").hidden = Boolean(code);
    $("link-url").textContent = code ? linkUrl(code) : "";
    renderList();
  }

  function warn(text) {
    var p = document.createElement("p");
    p.className = "warning";
    p.textContent = text;
    $("warnings").appendChild(p);
  }

  function filesConfirmed() {
    if ($("files").hidden || $("files-ok").checked) return true;
    setStatus("Check the file list first: a hand-built page shares every file in its folder.", true);
    return false;
  }

  function unshare(slug, email) {
    if (!confirm("Remove " + email + " from this page? Everyone on it is signed out and signs in again.")) return;
    run("Removing " + email, api("POST", "unshare", { slug: slug, email: email })).then(function (data) {
      state.shares[slug] = data.guests;
      select(slug);
      setStatus(data.guests.length
        ? "Removed " + email + ". They're signed out now, and again automatically over the next few minutes; the others sign in again."
        : "Removed " + email + ". Nobody else had access, so the page's rule is gone.");
    });
  }

  function copy(text, label) {
    navigator.clipboard.writeText(text).then(function () { setStatus(label + " copied."); }, function () {
      window.prompt("Copy this:", text);
    });
  }

  $("search").addEventListener("input", renderList);
  window.addEventListener("hashchange", function () {
    var slug = decodeURIComponent(location.hash.slice(1));
    if (state && state.pages[slug]) select(slug);
  });

  $("share-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var emails = $("emails").value.split(/[\s,;]+/).filter(Boolean);
    if (!emails.length) return setStatus("Type at least one email address.", true);
    if (!filesConfirmed()) return;
    var slug = current;
    run("Sharing", api("POST", "share", { slug: slug, emails: emails })).then(function (data) {
      state.shares[slug] = data.guests;
      $("emails").value = "";
      select(slug);
      setStatus("Shared with " + emails.join(", ") + ". Copy the link and message to send it.");
    });
  });

  $("copy-people").addEventListener("click", function () {
    copy(
      "Here's the page: " + pageUrl(current) + "\n" +
      "Click \"Sign in with Google\" and choose your Gmail account. If that doesn't work, type your email instead and enter the 6-digit code Cloudflare sends you (check spam). You'll stay signed in for 2 weeks.",
      "Link and message",
    );
  });

  function makeLink(reset) {
    if (!reset && !filesConfirmed()) return;
    var slug = current;
    run(reset ? "Resetting link" : "Creating link", api("POST", "link", { slug: slug, reset: reset, code: state.links[slug] })).then(function (data) {
      state.links[slug] = data.code;
      select(slug);
      setStatus(reset ? "New link made; the old one stops working shortly." : "Link created. It may take a minute to work everywhere.");
    });
  }
  $("link-create").addEventListener("click", function () { makeLink(false); });
  $("link-reset").addEventListener("click", function () {
    if (confirm("Make a new link? The old one stops working.")) makeLink(true);
  });
  $("link-off-btn").addEventListener("click", function () {
    if (!confirm("Turn off the link? It stops working shortly.")) return;
    var slug = current;
    run("Turning off the link", api("POST", "unlink", { slug: slug, code: state.links[slug] })).then(function () {
      delete state.links[slug];
      select(slug);
      setStatus("Link turned off. It stops working shortly (usually within a minute).");
    });
  });
  $("copy-link").addEventListener("click", function () {
    copy("Here's the page: " + linkUrl(state.links[current]) + "\nNo sign-in needed. Please don't forward it.", "Link and message");
  });

  load();
})();
