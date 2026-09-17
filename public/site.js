/**
 * Belline site behaviour. Shared by the landing page and every vertical page.
 *
 * Two pieces: the call panel in the hero, and the mobile menu. Both are
 * deliberately plain — no framework, no build step, and nothing here runs
 * before the markup it enhances already reads correctly.
 *
 * The German pages (/de-de, /de-at, /de-ch) load the same file. Every word it
 * writes into a page follows <html lang>, and so does how it writes money.
 */

/** A German page? Read once; every block below asks. */
var SITE_DE = /^de(?:-|$)/i.test(document.documentElement.getAttribute("lang") || "");
/** Swiss German writes "CHF 3’250" rather than "3.250 €". */
var SITE_CH = /^de-CH$/i.test(document.documentElement.getAttribute("lang") || "");

/* --- the call panel --------------------------------------------------------
   Scenes come from a JSON block in the page rather than being hard-coded
   here, so the landing page can show four trades and a vertical page can show
   two sides of one trade without a second copy of this file.

   Every line is what the agent actually says: same register, same refusal,
   same read-back. If the product's manner changes, these change with it. */
(function () {
  var call = document.getElementById("call");
  var data = document.getElementById("call-scenes");
  if (!call || !data) return;

  var scenes;
  try {
    scenes = JSON.parse(data.textContent);
  } catch (e) {
    scenes = null;
  }

  // The source page in public/ carries an empty block — the scenes are
  // injected when the static site is built. Serving that template directly
  // (which the app does, on its own hostname) left the panel dead: no tabs,
  // no transcript, and a Listen button wired to nothing. Falling back to the
  // shared file means the page works in either form.
  if (!scenes || !scenes.length) {
    fetch("/call-scenes.json")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (loaded) {
        if (loaded && loaded.length) start(loaded);
      })
      .catch(function () {
        /* The static markup around it still reads fine without the call. */
      });
    return;
  }

  start(scenes);

  function start(scenes) {

  var tabsEl = call.querySelector(".call-tabs");
  var body = call.querySelector(".call-body");
  var statusEl = call.querySelector(".call-status");
  var lineEl = call.querySelector(".call-line");

  var timers = [];
  var current = scenes[0];
  var still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* --- audio ---------------------------------------------------------------
     The page claims Belline sounds natural, and only the voice can make that
     case. Never automatic: sound that starts on its own is hostile, and on a
     phone the browser refuses it anyway. One element, reused, unlocked inside
     the click — created afterwards it would be refused silently. */
  var player = call.querySelector(".call-audio");
  var listenBtn = call.querySelector(".call-listen");
  var audible = false;

  function clearTimers() {
    timers.forEach(clearTimeout);
    timers = [];
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function turnEl(role, said) {
    var wrap = el("div", "turn " + role);
    wrap.appendChild(el("span", "who", role === "caller" ? "Caller" : "Belline"));
    wrap.appendChild(el("span", "said", said));
    return wrap;
  }

  function outcomeEl(outcome) {
    var wrap = el("div", "call-out");
    wrap.appendChild(el("span", "tag" + (outcome.human ? " human" : ""), outcome.tag));
    wrap.appendChild(el("span", "what", outcome.what));
    return wrap;
  }

  /**
   * What the panel says when a call has finished. Belline books nothing into
   * a calendar today: it takes the request for the team to confirm, or hands
   * the call to a person. check-webchat pins these words.
   */
  function doneStatus(scene) {
    return scene.outcome.human ? "Passed to the team" : "Request taken";
  }

  /**
   * A scene only plays aloud if every line has a recording (build-site.ts
   * withAudio). On a page where some scenes have one and some do not, Listen
   * is disabled for the silent scene rather than left to throw on a missing
   * clip.
   */
  function syncListen(scene) {
    if (!listenBtn) return;
    listenBtn.disabled = !scene.audio;
    listenBtn.title = scene.audio ? "" : "No recording for this call yet";
  }

  /** The whole scene at once — the resting state, and the reduced-motion one. */
  function paintAll(scene) {
    body.textContent = "";
    scene.turns.forEach(function (t) {
      body.appendChild(turnEl(t[0], t[1]));
    });
    body.appendChild(outcomeEl(scene.outcome));
    statusEl.textContent = doneStatus(scene);
    call.setAttribute("data-speaking", "false");
    syncListen(scene);
  }

  /**
   * Play the scene with its recordings, advancing on each clip ending.
   *
   * Driven by the audio rather than a timer, so the transcript cannot drift
   * out of step with the voice — the failure that makes a demo like this feel
   * fake. A clip that will not load is not fatal: the line still appears and
   * the scene carries on, because a missing recording should cost sound, not
   * the whole conversation.
   */
  function playAudible(scene) {
    clearTimers();
    current = scene;
    lineEl.textContent = scene.when;
    body.textContent = "";
    statusEl.textContent = "Ringing";

    var i = 0;
    function next() {
      if (i >= scene.turns.length) {
        call.setAttribute("data-speaking", "false");
        statusEl.textContent = doneStatus(scene);
        body.appendChild(outcomeEl(scene.outcome));
        setListening(false);
        return;
      }
      var turn = scene.turns[i];
      var isAgent = turn[0] === "agent";
      call.setAttribute("data-speaking", String(isAgent));
      statusEl.textContent = isAgent ? "Answered" : "Listening";
      body.appendChild(turnEl(turn[0], turn[1]));

      player.onended = function () {
        i++;
        next();
      };
      player.onerror = function () {
        i++;
        // A short beat so the lines do not all land at once.
        timers.push(setTimeout(next, 900));
      };
      // A path, already fingerprinted by the build. The older data had bare
      // filenames, which is tolerated here so a cached copy of the JSON does
      // not go silent on the way through a deploy.
      var clip = scene.audio[i];
      player.src = clip.charAt(0) === "/" ? clip : "/audio/" + clip;
      var started = player.play();
      if (started && started.catch) {
        started.catch(function () {
          i++;
          timers.push(setTimeout(next, 900));
        });
      }
    }
    next();
  }

  function setListening(on) {
    audible = on;
    if (!listenBtn) return;
    listenBtn.setAttribute("aria-pressed", String(on));
    listenBtn.querySelector(".call-listen-label").textContent = on ? "Stop" : "Listen";
  }

  function play(scene) {
    syncListen(scene);
    if (audible && scene.audio) {
      playAudible(scene);
      return;
    }
    // Listening, then switching to a scene with no recording: stop the sound
    // and show that scene as text rather than half-playing it.
    if (audible) {
      player.pause();
      setListening(false);
    }
    clearTimers();
    current = scene;
    lineEl.textContent = scene.when;

    // Blanking the panel and rebuilding it on timers is only safe while the
    // tab is on screen: a background tab throttles setTimeout to a crawl, so
    // the panel would sit empty on "Ringing" and the visitor would come back
    // to what looks like a broken box. When we cannot animate honestly, show
    // the finished call instead.
    if (still || document.visibilityState !== "visible") {
      paintAll(scene);
      return;
    }

    statusEl.textContent = "Ringing";
    call.setAttribute("data-speaking", "false");

    var at = 520;
    scene.turns.forEach(function (t, i) {
      timers.push(
        setTimeout(function () {
          // Geleert wird erst, wenn die erste Zeile da ist — nicht vorher.
          // Vorher stand hier ein halbe Sekunde langes leeres Feld, und ein
          // leeres Feld im Hero ist das, was ein Screenshot, eine Vorschau und
          // jeder, der schnell scrollt, von der Seite mitnimmt.
          if (i === 0) body.textContent = "";
          if (t[0] === "agent") {
            call.setAttribute("data-speaking", "true");
            // "Answered", never "Checking the book": Belline does not look
            // into a calendar on these calls, it takes the request.
            statusEl.textContent = "Answered";
          } else {
            call.setAttribute("data-speaking", "false");
            statusEl.textContent = "Listening";
          }
          body.appendChild(turnEl(t[0], t[1]));
        }, at),
      );
      // Roughly how long the line takes to say, floored so a short line does
      // not flick past before it can be read.
      at += Math.max(1500, t[1].length * 42);
    });

    timers.push(
      setTimeout(function () {
        call.setAttribute("data-speaking", "false");
        statusEl.textContent = doneStatus(scene);
        body.appendChild(outcomeEl(scene.outcome));
      }, at),
    );
  }

  // Leaving the tab abandons the animation mid-sentence. Rather than resuming
  // into nonsense on return, settle on the completed call.
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") {
      clearTimers();
      paintAll(current);
    }
  });

  var tabs = [];

  function select(i) {
    tabs.forEach(function (t, j) {
      t.setAttribute("aria-selected", String(i === j));
    });
    body.setAttribute("aria-labelledby", tabs[i].id);
    play(scenes[i]);
  }

  // One tab per scene, built from the data — a page with a single scene gets
  // no tab strip at all rather than a lone tab that does nothing.
  if (scenes.length > 1) {
    scenes.forEach(function (scene, i) {
      var tab = el("button", "call-tab", scene.label);
      tab.type = "button";
      tab.id = "call-tab-" + i;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-controls", body.id);
      tab.setAttribute("aria-selected", String(i === 0));
      tab.addEventListener("click", function () {
        select(i);
      });
      // Roving arrow keys are what makes a tablist a tablist to a keyboard.
      tab.addEventListener("keydown", function (e) {
        var next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : -1;
        if (next < 0 || next >= tabs.length) return;
        e.preventDefault();
        tabs[next].focus();
        select(next);
      });
      tabs.push(tab);
      tabsEl.appendChild(tab);
    });
    body.setAttribute("aria-labelledby", tabs[0].id);
  } else {
    tabsEl.remove();
  }

  // The listen button only exists if there are recordings to play.
  if (listenBtn) {
    if (!scenes.some(function (s) { return s.audio; })) {
      listenBtn.remove();
      listenBtn = null;
    } else {
      listenBtn.addEventListener("click", function () {
        if (!current.audio) return;
        if (audible) {
          player.pause();
          setListening(false);
          paintAll(current);
          return;
        }
        // Unlock inside the gesture, then start. Doing this after any await
        // ends the gesture and the browser refuses, silently on phones.
        setListening(true);
        playAudible(current);
      });
    }
  }

  // Paint the first scene immediately so the page is never blank at rest,
  // then play it once it is actually on screen.
  paintAll(scenes[0]);
  if (!still && "IntersectionObserver" in window) {
    var seen = false;
    new IntersectionObserver(
      function (entries, obs) {
        if (entries[0].isIntersecting && !seen) {
          seen = true;
          obs.disconnect();
          play(scenes[0]);
        }
      },
      { threshold: 0.4 },
    ).observe(call);
  }

  } // start
})();

/* --- mobile menu ---------------------------------------------------------- */
(function () {
  var toggle = document.querySelector(".menu-toggle");
  var nav = document.getElementById("site-nav");
  if (!toggle || !nav) return;

  function setOpen(open) {
    nav.setAttribute("data-open", String(open));
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", SITE_DE ? (open ? "Menü schließen" : "Menü öffnen") : open ? "Close menu" : "Open menu");
    // The nav comes before the toggle in the page, so Tab from the toggle went
    // to the page behind the menu. Opening it puts the first link in reach —
    // after the 0.18s fade, because a link still at visibility: hidden cannot
    // take focus. A timer, not transitionend: with reduced motion there may be
    // no transition to end.
    if (open) {
      setTimeout(function () {
        if (nav.getAttribute("data-open") !== "true") return;
        var first = nav.querySelector("a");
        if (first) first.focus();
      }, 200);
    }
  }

  toggle.addEventListener("click", function () {
    setOpen(nav.getAttribute("data-open") !== "true");
  });

  // Tapping a link should close the panel behind it, or the next page loads
  // underneath an open menu.
  nav.addEventListener("click", function (e) {
    if (e.target.tagName === "A") setOpen(false);
  });

  // Only while it is open, and back to the toggle, so focus is not left on a
  // link that has just been hidden.
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && nav.getAttribute("data-open") === "true") {
      setOpen(false);
      toggle.focus();
    }
  });

  // Must track the CSS breakpoint, or the panel stays open and orphaned when
  // a rotating tablet crosses back into the desktop header.
  window.matchMedia("(min-width: 901px)").addEventListener("change", function (e) {
    if (e.matches) setOpen(false);
  });
})();

/* --- the call panel --------------------------------------------------------
   The bell opens a real conversation with Belline, not a form. It is an
   ordinary link to app.belline.ai/call, so with JavaScript off — or if any of
   this throws — it simply navigates there and still works. Everything below
   only upgrades it to a panel. */
(function () {
  // Every way in, not just the first. The hero button and the floating bell
  // both open the same call, and `querySelector` quietly picked whichever
  // came first in the markup — which meant adding the hero button left the
  // bell inert and hid the wrong element on answer.
  var triggers = [].slice.call(document.querySelectorAll("[data-call]"));
  if (!triggers.length) return;

  var bell = document.querySelector(".bell-fab") || triggers[0];

  // No panel on a small screen: a live call in a 340px iframe is worse than
  // the page it would cover, and the full page is a better phone experience.
  if (!window.matchMedia("(min-width: 760px)").matches) return;

  var dock = null;

  function close() {
    if (!dock) return;
    dock.remove();
    dock = null;
    bell.hidden = false;
    document.removeEventListener("keydown", onKey);
    bell.focus();
  }

  function onKey(e) {
    if (e.key === "Escape") close();
  }

  /**
   * Dock the call where the bell was, rather than over the page.
   *
   * A modal says "you have left what you were doing". A call does not need
   * that — somebody halfway down the pricing section who wants to ask a
   * question should keep their place while they ask it, exactly as they would
   * with a phone against their ear.
   */
  function open(e) {
    e.preventDefault();
    if (dock) return;

    // The bell becomes the call: two of them on screen at once would be the
    // page offering to ring somebody it is already talking to.
    bell.hidden = true;

    dock = document.createElement("div");
    dock.className = "call-dock";
    dock.setAttribute("role", "region");
    dock.setAttribute("aria-label", SITE_DE ? "Anruf mit Belline" : "Call with Belline");

    var frame = document.createElement("iframe");
    frame.src = bell.getAttribute("href");
    frame.title = SITE_DE ? "Anruf mit Belline" : "Call with Belline";
    // Without this the microphone is blocked inside the frame and the call is
    // silent with no error a visitor could act on.
    frame.allow = "microphone";
    frame.className = "call-frame";

    var shut = document.createElement("button");
    shut.type = "button";
    shut.className = "call-shut";
    shut.setAttribute("aria-label", SITE_DE ? "Anruf schließen" : "Close the call");
    shut.textContent = "×";
    shut.addEventListener("click", close);

    dock.appendChild(frame);
    dock.appendChild(shut);
    document.body.appendChild(dock);
    // Into the dock, so a keyboard is not left on the page behind it.
    shut.focus();
    document.addEventListener("keydown", onKey);
  }

  triggers.forEach(function (t) {
    t.addEventListener("click", open);
  });

  /**
   * Grow the dock when Belline puts times on screen.
   *
   * An iframe cannot resize itself, so it asks. Only app.belline.ai is
   * listened to, and only for a height inside a range we chose — a page that
   * accepts layout instructions from any origin is a page anybody can reshape,
   * and one that accepts any number is one frame away from covering the whole
   * screen.
   */
  window.addEventListener("message", function (e) {
    if (e.origin !== "https://app.belline.ai") return;
    var msg = e.data;
    if (!msg || msg.source !== "belline-call") return;
    var h = Number(msg.height);
    if (!dock || !(h >= 60 && h <= 320)) return;
    dock.querySelector(".call-frame").style.height = h + "px";
  });
})();

/* --- the chat panel --------------------------------------------------------
   The other way in. Belline's own website is a customer of this product like
   any other: the panel below is the same embedded chat a venue pastes into
   their own site, pointed at our own venue and our own diary. Which means it
   cannot quietly rot — if the chat a customer is paying for breaks, the one on
   the front page breaks with it, in public.

   The button ships hidden and is revealed here. Without JavaScript there is
   nothing to open — the conversation *is* the frame — and a button that does
   nothing is worse than no button. */
(function () {
  var fab = document.querySelector("[data-chat]");
  if (!fab) return;

  var dock = null;

  function close() {
    if (!dock) return;
    dock.remove();
    dock = null;
    fab.hidden = false;
    document.removeEventListener("keydown", onKey);
    try {
      fab.focus();
    } catch (e) {
      /* focus is a nicety, never a failure */
    }
  }

  function onKey(e) {
    if (e.key === "Escape") close();
  }

  function open() {
    if (dock) return;
    // The button becomes the panel, as the bell does: two invitations to the
    // same conversation, one of which is already open.
    fab.hidden = true;

    dock = document.createElement("div");
    dock.className = "chat-dock";
    dock.setAttribute("role", "region");
    dock.setAttribute("aria-label", SITE_DE ? "Chat mit Belline" : "Chat with Belline");

    var frame = document.createElement("iframe");
    // Our origin goes in the URL so the edge can name it in frame-ancestors.
    // Without it the browser refuses the page before it is parsed.
    frame.src =
      fab.getAttribute("data-chat") + "?o=" + encodeURIComponent(location.origin);
    frame.title = SITE_DE ? "Chat mit Belline" : "Chat with Belline";
    frame.className = "chat-frame";
    // For the voice note. The browser asks only when the visitor holds the
    // microphone button inside the chat, never on opening.
    frame.allow = "microphone";

    var shut = document.createElement("button");
    shut.type = "button";
    shut.className = "call-shut";
    shut.setAttribute("aria-label", SITE_DE ? "Chat schließen" : "Close the chat");
    shut.textContent = "×";
    shut.addEventListener("click", close);

    dock.appendChild(frame);
    dock.appendChild(shut);
    document.body.appendChild(dock);
    // Into the dock, so a keyboard is not left on the page behind it.
    shut.focus();
    document.addEventListener("keydown", onKey);
  }

  fab.addEventListener("click", open);
  fab.hidden = false;

  // "Write with Belle on belline.ai" from the WhatsApp page lands here with
  // ?chat=1. It used to land on #channels, a paragraph about the chat rather
  // than the chat.
  if (/[?&]chat=1(?:&|$)/.test(window.location.search)) open();
})();

/* --- the video receptionist ------------------------------------------------
   Belline's video receptionist, on our own site — and only once it is switched
   on for our own venue. Nothing is in the markup: when the venue's widget
   config says `video: true`, this loads embed-video.js from the app, which
   opens a round greeting bubble above the floating buttons (a muted clip or a
   poster; no session, no microphone) and, on a tap, the call itself. With the
   feature off, as in production until approved, the page is the page it was.

   A labelled Video button joins the stack once the bubble has been closed, so
   the receptionist stays one tap away without greeting again on every page. */
(function () {
  var chatFab = document.querySelector("[data-chat]");
  if (!chatFab || typeof window.fetch !== "function") return;
  var chatUrl = chatFab.getAttribute("data-chat") || "";
  var match = /^(https?:\/\/[^/]+)\/embed\/([^/]+)\/chat$/.exec(chatUrl);
  if (!match) return;
  var appOrigin = match[1];
  var key = match[2];

  var label = SITE_DE ? "Videoanruf mit Belle" : "Video call with Belle";
  var fab = null;
  var dock = null;
  var ctl = null;

  function makeFab() {
    fab = document.createElement("button");
    fab.type = "button";
    fab.className = "video-fab";
    fab.hidden = true;
    fab.setAttribute("aria-label", label);
    fab.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<rect x="3" y="6.5" width="12.5" height="11" rx="2.5" stroke="currentColor" stroke-width="1.5"/>' +
      '<path d="M15.5 10.6 20.4 8v8l-4.9-2.6Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>' +
      '<span class="video-fab-say">' + label + "</span>";
    fab.addEventListener("click", function () {
      if (ctl) ctl.reopen();
    });
    document.body.appendChild(fab);
  }

  function ready(api) {
    ctl = api.mount({
      env: window,
      config: window.__bellineVideoConfig || {},
      origin: appOrigin,
      key: key,
      hostOrigin: location.origin,
      fixed: true,
      place: function (bubble) {
        bubble.classList.add("video-bubble");
        document.body.appendChild(bubble);
      },
      onBubbleShown: function () {
        fab.hidden = true;
      },
      onDismissed: function () {
        fab.hidden = false;
      },
      frameClass: "video-frame",
      shutClass: "call-shut",
      placeCall: function (frame, shut) {
        dock = document.createElement("div");
        dock.className = "video-dock";
        dock.setAttribute("role", "region");
        dock.setAttribute("aria-label", label);
        dock.appendChild(frame);
        dock.appendChild(shut);
        document.body.appendChild(dock);
        shut.focus();
        fab.hidden = true;
      },
      onCallClosed: function () {
        var gone = dock;
        dock = null;
        // The frame is removed by embed-video.js a moment later; the dock with it.
        setTimeout(function () {
          if (gone) gone.remove();
        }, 400);
        fab.hidden = false;
        try {
          fab.focus();
        } catch (e) {
          /* focus is a nicety, never a failure */
        }
      },
    });
    // Dismissed earlier this session: no greeting, so the button is the way in.
    if (!ctl.state().bubble) fab.hidden = false;
  }

  fetch(appOrigin + "/api/embed/" + key + "/config", { mode: "cors" })
    .then(function (r) {
      return r.ok ? r.json() : null;
    })
    .then(function (cfg) {
      if (!cfg || cfg.video !== true) return;
      makeFab();
      window.__bellineVideoConfig = cfg.videoBubble || {};
      if (window.BellineVideo) return ready(window.BellineVideo);
      (window.__bellineVideoReady = window.__bellineVideoReady || []).push(ready);
      var s = document.createElement("script");
      s.src = appOrigin + "/embed-video.js";
      s.async = true;
      document.head.appendChild(s);
    })
    .catch(function () {
      /* no bubble is the right failure */
    });
})();

/* --- monthly / annual ------------------------------------------------------
   The prices for both cycles are already in the markup as data attributes, so
   the page reads correctly with no JavaScript at all and this only swaps
   between two sets of numbers that are both already true. */
(function () {
  var group = document.querySelector(".cycle");
  if (!group) return;

  var options = group.querySelectorAll(".cycle-opt");

  function show(cycle) {
    options.forEach(function (opt) {
      var on = opt.getAttribute("data-cycle") === cycle;
      opt.classList.toggle("is-on", on);
      opt.setAttribute("aria-pressed", String(on));
    });
    document.querySelectorAll("[data-" + cycle + "]").forEach(function (el) {
      el.textContent = el.getAttribute("data-" + cycle);
    });
  }

  group.addEventListener("click", function (e) {
    var opt = e.target.closest(".cycle-opt");
    if (opt) show(opt.getAttribute("data-cycle"));
  });
})();

/* --- which country's prices ------------------------------------------------
   Rendered only when more than one market is open (scripts/site-pricing.ts).
   Every market's block is already in the markup, generated from the same
   catalogue; this only chooses which one is visible. */
(function () {
  var pick = document.querySelector("[data-market-pick]");
  if (!pick) return;
  pick.addEventListener("change", function () {
    document.querySelectorAll(".market[data-market]").forEach(function (el) {
      el.hidden = el.getAttribute("data-market") !== pick.value;
    });
  });
})();

/* --- book a call -----------------------------------------------------------
   The email check is the point of this block. A mistyped domain — gmial.com,
   hotmial.com — passes every syntax test ever written, and the reply then
   vanishes without a bounce anybody reads, which for a form that exists to
   produce a reply is total failure that looks like success.

   So the browser offers a correction, and the server resolves the domain's
   mail records before accepting it. Neither refuses an address outright on
   spelling alone: somebody's real mailbox may genuinely be at an address one
   letter from a famous one, and a form telling a customer they do not exist
   is worse than a bounce. */
(function () {
  var form = document.getElementById("book-form");
  if (!form) return;

  var note = document.getElementById("book-note");
  var submit = form.querySelector(".book-submit");
  var endpoint = "https://app.belline.ai/api/leads";

  // Same list as the server's, and for the same reason.
  var KNOWN = [
    "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
    "msn.com", "yahoo.com", "yahoo.co.uk", "icloud.com", "me.com", "proton.me",
    "protonmail.com", "aol.com", "zoho.com", "emirates.net.ae", "eim.ae",
    "etisalat.ae", "du.ae"
  ];

  // Damerau-Levenshtein, not plain Levenshtein. A swap of two neighbours is
  // one mistake, not two — which is why gmial.com is recognised as gmail.com.
  // Kept in step with distance() in src/lib/leads/email.ts.
  function distance(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 99;
    var beforePrev = [];
    var prev = [];
    for (var j = 0; j <= b.length; j++) prev[j] = j;

    for (var i = 1; i <= a.length; i++) {
      var row = [i];
      for (var k = 1; k <= b.length; k++) {
        var cost = a[i - 1] === b[k - 1] ? 0 : 1;
        row[k] = Math.min(prev[k] + 1, row[k - 1] + 1, prev[k - 1] + cost);
        if (i > 1 && k > 1 && a[i - 1] === b[k - 2] && a[i - 2] === b[k - 1]) {
          row[k] = Math.min(row[k], beforePrev[k - 2] + 1);
        }
      }
      beforePrev = prev;
      prev = row;
    }
    return prev[b.length];
  }

  function suggest(email) {
    var at = email.lastIndexOf("@");
    if (at < 0) return null;
    var domain = email.slice(at + 1).toLowerCase();
    if (KNOWN.indexOf(domain) !== -1) return null;

    var best = null;
    KNOWN.forEach(function (known) {
      var d = distance(domain, known);
      var limit = known.length > 12 ? 2 : 1;
      if (d <= limit && (!best || d < best.d)) best = { domain: known, d: d };
    });
    return best ? email.slice(0, at) + "@" + best.domain : null;
  }

  function fieldOf(input) {
    return input.closest(".f");
  }

  function clear(input) {
    input.classList.remove("is-bad");
    input.classList.remove("is-hint");
    var slot = fieldOf(input) && fieldOf(input).querySelector(".f-err");
    if (slot) {
      slot.hidden = true;
      slot.textContent = "";
      slot.classList.remove("is-hint");
    }
  }

  /**
   * @param tone "bad" for a refusal, "hint" for a spelling suggestion.
   *
   * The distinction matters: a suggestion is a question, not a rejection, and
   * painting it red tells somebody with an unusual but perfectly real address
   * that they have got their own email wrong.
   */
  function mark(input, message, suggestion, tone, onKeep) {
    input.classList.add(tone === "hint" ? "is-hint" : "is-bad");
    var slot = fieldOf(input) && fieldOf(input).querySelector(".f-err");
    if (!slot) return;
    slot.hidden = false;
    slot.classList.toggle("is-hint", tone === "hint");
    slot.textContent = message + " ";

    if (suggestion) {
      var fix = document.createElement("button");
      fix.type = "button";
      fix.textContent = "Use " + suggestion;
      fix.addEventListener("click", function () {
        input.value = suggestion;
        clear(input);
        input.focus();
      });
      slot.appendChild(fix);
    }

    // The other half of asking: somebody whose address really does sit one
    // letter from a famous domain has to be able to say so and get on with it.
    if (onKeep) {
      slot.appendChild(document.createTextNode(" or "));
      var keep = document.createElement("button");
      keep.type = "button";
      keep.textContent = "keep mine";
      keep.addEventListener("click", onKeep);
      slot.appendChild(keep);
    }
  }

  function fail(input, message, suggestion) {
    mark(input, message, suggestion, "bad");
  }

  var email = form.elements.email;

  // On blur, not on every keystroke: correcting somebody while they are still
  // typing their own address is the form arguing with them.
  email.addEventListener("blur", function () {
    var value = email.value.trim();
    if (!value) return;
    var better = suggest(value);
    if (better) mark(email, "That domain looks like a typo.", better, "hint");
  });

  form.addEventListener("input", function (e) {
    if (e.target.classList.contains("is-bad") || e.target.classList.contains("is-hint")) {
      clear(e.target);
    }
  });

  // The visitor's own timezone, so "weekday mornings" means their morning.
  try {
    form.elements.timezone.value = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch (err) {
    /* Old browser. The field stays empty and we ask on the call. */
  }

  // Which button they came from, so a "High volume" enquiry is not answered
  // with a Starter pitch.
  document.querySelectorAll("[data-plan]").forEach(function (link) {
    link.addEventListener("click", function () {
      form.elements.source.value = "website: " + link.getAttribute("data-plan");
    });
  });
  var bell = document.getElementById("bell-btn");
  if (bell) {
    bell.addEventListener("click", function () {
      form.elements.source.value = "website: voice button";
      document.getElementById("book").scrollIntoView({ behavior: "smooth", block: "start" });
      form.elements.name.focus({ preventScroll: true });
    });
  }

  function say(message, tone) {
    note.textContent = message;
    note.classList.toggle("is-good", tone === "good");
    note.classList.toggle("is-bad", tone === "bad");
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();

    var required = ["name", "company", "email", "phone"];
    var firstBad = null;

    required.forEach(function (field) {
      var input = form.elements[field];
      if (!input.value.trim()) {
        fail(input, "Required.");
        if (!firstBad) firstBad = input;
      }
    });

    if (firstBad) {
      firstBad.focus();
      say("Fill in the four marked fields and we will do the rest.", "bad");
      return;
    }

    send(false);
  });

  function send(emailConfirmed) {
    var payload = { emailConfirmed: emailConfirmed ? 1 : "" };
    ["name", "company", "email", "phone", "website", "vertical", "venues", "intent",
     "callVolume", "availability", "timezone", "notes", "source", "website2"
    ].forEach(function (field) {
      if (form.elements[field]) payload[field] = form.elements[field].value;
    });

    submit.disabled = true;
    submit.textContent = "Booking…";
    say("Checking that we can actually reach you…");

    fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    })
      .then(function (res) {
        return res.json().then(function (body) { return { status: res.status, body: body }; });
      })
      .then(function (result) {
        if (result.status === 200 && result.body.ok) {
          form.querySelectorAll(".f, .hp").forEach(function (el) { el.remove(); });
          submit.remove();
          say(result.body.message || "Booked in. We will be in touch.", "good");
          return;
        }

        submit.disabled = false;
        submit.textContent = "Book the call";

        var field = result.body.field && form.elements[result.body.field];
        if (!field) {
          say(result.body.error || "That did not go through. Email hello@belline.ai.", "bad");
          return;
        }

        if (result.body.confirmable) {
          // A question, not a refusal. Answer it either way and the same
          // submission goes straight through.
          mark(field, result.body.error, result.body.suggestion, "hint", function () {
            clear(field);
            send(true);
          });
          field.focus();
          say("Just checking that address before we reply to it.");
          return;
        }

        fail(field, result.body.error, result.body.suggestion);
        field.focus();
        say("Almost — one thing to fix.", "bad");
      })
      .catch(function () {
        submit.disabled = false;
        submit.textContent = "Book the call";
        // Never strand somebody with a dead form: the address is the fallback.
        say("Could not reach us just then. Email hello@belline.ai and we will reply today.", "bad");
      });
  }
})();

/* --- what the missed calls are worth ---------------------------------------
   The visitor's own three numbers and nothing else. No industry average, no
   "venues lose 30%": an owner knows how many calls go unanswered and what a
   booking is worth far better than we do, and an invented figure is the
   fastest way to lose the one who knows. The markup carries the answer for
   the example numbers, so the page reads correctly without JavaScript. */
(function () {
  var form = document.getElementById("roi");
  var out = document.getElementById("roi-out");
  if (!form || !out) return;

  function num(name) {
    var v = parseFloat(form.elements[name].value);
    return isFinite(v) && v >= 0 ? v : 0;
  }

  function aed(n) {
    return "AED " + Math.round(n).toLocaleString("en-AE");
  }

  // A German page writes money as scripts/site-pricing-de.ts does, by hand
  // rather than through Intl, so the number the page ships with and the one
  // written here are the same characters: "3.250 €", or "CHF 3’250".
  var currency = form.querySelector('[data-gen="roi-currency"]');
  function money(n) {
    if (!SITE_DE) return aed(n);
    var digits = String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, SITE_CH ? "’" : ".");
    var code = currency ? currency.textContent.trim() : "€";
    return code === "€" ? digits + " €" : code + " " + digits;
  }

  // The line under the big number: bookings, and the comparison with the
  // chosen plan. Same words as renderRoi() in scripts/site-pricing.ts.
  var detail = form.querySelector('[data-gen="roi-detail"]');

  function render() {
    var missed = num("missed");
    var share = Math.min(num("share"), 100) / 100;
    var value = num("value");
    var plan = form.elements.plan;
    var price = parseFloat(plan.value) || 0;
    var planName = plan.options[plan.selectedIndex].getAttribute("data-name");
    if (!missed || !share || !value) {
      out.textContent = SITE_DE ? "Bitte alle drei Zahlen ausfüllen" : "Fill in all three numbers";
      if (detail) detail.textContent = "";
      return;
    }
    // 52 weeks over 12 months, not four weeks a month.
    var bookings = (missed * share * 52) / 12;
    var worth = Math.round(bookings * value);
    var n = Math.round(bookings);
    if (SITE_DE) {
      // Dieselben Worte wie renderRoiDe() in scripts/site-pricing-de.ts.
      out.textContent = "Etwa " + money(worth) + " pro Monat";
      if (detail) {
        detail.textContent =
          "Das sind etwa " + n + " " + (n === 1 ? "Buchung" : "Buchungen") + " pro Monat, " +
          (worth >= price ? "mehr" : "weniger") + " als " + planName + " kostet.";
      }
      return;
    }
    out.textContent = "About " + aed(worth) + " a month";
    if (detail) {
      detail.textContent =
        "That’s about " + n + " booking" + (n === 1 ? "" : "s") + " a month, " +
        (worth >= price ? "more" : "less") + " than " + planName + " costs.";
    }
  }

  form.addEventListener("input", render);
  form.addEventListener("change", render);
  form.addEventListener("submit", function (e) { e.preventDefault(); });
  render();
})();

/* The buy bar that used to replace the three buttons on a phone once the hero
   was scrolled past is gone: the three ways to reach Belle stay where they
   are at every height of the page. */

/* The three floating buttons used to wait for the hero to scroll off before
   appearing, so that they did not sit on its example cards. That hid the
   three ways of reaching Belline at the one moment everybody sees — the first
   paint — so it is gone. They are on screen from the start, and the hero is
   given the room instead (see "Platz für die Knöpfe" in site.css). */

/* --- the integrations strip ------------------------------------------------
   A slow, continuous line of the systems Belline connects to (or plans to).
   The page ships a still list; this only adds the movement, and only for
   visitors who have not asked for reduced motion. A hidden copy of the list
   follows the first so the loop has no seam, and the Pause button is there
   because moving content must be stoppable (WCAG 2.2.2), not just on hover. */
(function () {
  var section = document.getElementById("connects");
  if (!section) return;
  var list = section.querySelector(".connects-list");
  var pause = section.querySelector(".connects-pause");
  if (!list || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  var rail = document.createElement("div");
  rail.className = "connects-rail";
  var track = document.createElement("div");
  track.className = "connects-track";
  list.parentNode.insertBefore(rail, list);
  rail.appendChild(track);
  track.appendChild(list);

  var copy = list.cloneNode(true);
  copy.setAttribute("aria-hidden", "true");
  copy.removeAttribute("aria-label");
  track.appendChild(copy);

  // Lazy icons would wait for the viewport and slide in blank: load them all now (they are tiny).
  Array.prototype.forEach.call(section.querySelectorAll("img"), function (img) { img.loading = "eager"; });
  section.classList.add("is-moving");
  // About 30px a second, whatever the screen: the duration follows the list's width.
  var speed = function () {
    track.style.setProperty("--connects-duration", Math.max(20, list.scrollWidth / 30) + "s");
  };
  speed();
  window.addEventListener("resize", speed);

  if (pause) {
    pause.hidden = false;
    pause.addEventListener("click", function () {
      var paused = section.classList.toggle("is-paused");
      pause.setAttribute("aria-pressed", paused ? "true" : "false");
      pause.textContent = SITE_DE ? (paused ? "Abspielen" : "Anhalten") : paused ? "Play" : "Pause";
    });
  }
})();

/* --- country and language --------------------------------------------------
   The picker ships as a <details>, which opens and navigates with no
   JavaScript (scripts/site-locale.ts). Here it becomes a real button with
   aria-expanded controlling the panel, and the panel closes on Escape, on a
   click outside and when focus leaves it. In the phone menu it is the same
   element, full width, with the panel in the flow of the menu. */
(function () {
  var details = document.querySelector("details.locale");
  if (!details) return;
  var summary = details.querySelector("summary");
  var panel = details.querySelector(".locale-panel");
  if (!summary || !panel || !panel.id) return;

  var wrap = document.createElement("div");
  wrap.className = "locale";
  wrap.setAttribute("data-locale", details.getAttribute("data-locale") || "");

  var button = document.createElement("button");
  button.type = "button";
  button.className = "locale-btn";
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", panel.id);
  while (summary.firstChild) button.appendChild(summary.firstChild);

  panel.hidden = true;
  wrap.appendChild(button);
  wrap.appendChild(panel);
  details.parentNode.replaceChild(wrap, details);

  function isOpen() {
    return button.getAttribute("aria-expanded") === "true";
  }

  function setOpen(open) {
    button.setAttribute("aria-expanded", String(open));
    panel.hidden = !open;
    wrap.classList.toggle("is-open", open);
  }

  button.addEventListener("click", function () {
    setOpen(!isOpen());
  });

  document.addEventListener("click", function (e) {
    if (isOpen() && !wrap.contains(e.target)) setOpen(false);
  });

  // Capturing, and stopped here: in the phone menu, Escape closes the picker
  // first and leaves the menu open, rather than shutting both at once.
  document.addEventListener(
    "keydown",
    function (e) {
      if (e.key !== "Escape" || !isOpen()) return;
      e.stopPropagation();
      setOpen(false);
      button.focus();
    },
    true,
  );

  wrap.addEventListener("focusout", function (e) {
    if (isOpen() && e.relatedTarget && !wrap.contains(e.relatedTarget)) setOpen(false);
  });
})();

/* --- the waitlist ------------------------------------------------------------
   Only on the German pages, where nothing is for sale yet. The form posts to
   app.belline.ai/api/leads/waitlist; without JavaScript the browser submits it
   and gets a plain German page back. With it, the visitor stays here, each
   problem is written next to its field, and a typo in a big mail provider's
   domain is asked about once, as the book-a-call form does. */
(function () {
  var form = document.getElementById("warteliste");
  if (!form || !form.getAttribute("action")) return;

  var note = form.querySelector(".waitlist-note");
  var submit = form.querySelector(".book-submit");
  var endpoint = form.getAttribute("action");
  var label = submit ? submit.textContent : "";

  function slot(input) {
    var field = input.closest(".f");
    return field && field.querySelector(".f-err");
  }

  function clear(input) {
    input.classList.remove("is-bad");
    input.classList.remove("is-hint");
    input.removeAttribute("aria-invalid");
    var s = slot(input);
    if (s) {
      s.hidden = true;
      s.textContent = "";
    }
  }

  function fail(input, message, suggestion, onKeep) {
    input.classList.add(onKeep ? "is-hint" : "is-bad");
    input.setAttribute("aria-invalid", "true");
    var s = slot(input);
    if (!s) return;
    s.hidden = false;
    s.textContent = message + " ";
    if (suggestion) {
      var use = document.createElement("button");
      use.type = "button";
      use.textContent = suggestion + " verwenden";
      use.addEventListener("click", function () {
        input.value = suggestion;
        clear(input);
        input.focus();
      });
      s.appendChild(use);
    }
    if (onKeep) {
      s.appendChild(document.createTextNode(" oder "));
      var keep = document.createElement("button");
      keep.type = "button";
      keep.textContent = "meine behalten";
      keep.addEventListener("click", onKeep);
      s.appendChild(keep);
    }
  }

  function say(message, tone) {
    if (!note) return;
    note.textContent = message;
    note.classList.toggle("is-good", tone === "good");
    note.classList.toggle("is-bad", tone === "bad");
  }

  form.addEventListener("input", function (e) {
    if (e.target.classList && (e.target.classList.contains("is-bad") || e.target.classList.contains("is-hint"))) clear(e.target);
    // Once nothing is marked any more, the summary under the button goes too.
    // Fields only: the note itself carries .is-bad while it shows, and matched itself before.
    if (note && note.classList.contains("is-bad") && !form.querySelector("input.is-bad, select.is-bad, textarea.is-bad, input.is-hint")) say("");
  });

  var REQUIRED = {
    name: "Bitte geben Sie Ihren Namen an.",
    email: "Bitte geben Sie Ihre E-Mail-Adresse an.",
    company: "Bitte geben Sie den Namen Ihres Unternehmens an.",
    country: "Bitte wählen Sie Ihr Land."
  };

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var firstBad = null;
    Object.keys(REQUIRED).forEach(function (name) {
      var input = form.elements[name];
      clear(input);
      var value = input.value.trim();
      var message = !value ? REQUIRED[name] : name === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? "Diese E-Mail-Adresse ist nicht vollständig." : "";
      if (message) {
        fail(input, message);
        if (!firstBad) firstBad = input;
      }
    });
    if (firstBad) {
      firstBad.focus();
      say("Bitte korrigieren Sie die markierten Felder.", "bad");
      return;
    }
    send(false);
  });

  function send(emailConfirmed) {
    var payload = { emailConfirmed: emailConfirmed ? true : false };
    ["name", "email", "company", "country", "businessType", "page", "website2"].forEach(function (name) {
      if (form.elements[name]) payload[name] = form.elements[name].value;
    });

    submit.disabled = true;
    submit.textContent = "Wird gesendet…";
    say("");

    fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    })
      .then(function (res) {
        return res.json().then(function (body) { return { status: res.status, body: body }; });
      })
      .then(function (result) {
        if (result.status === 200 && result.body.ok) {
          var done = document.createElement("div");
          done.className = "waitlist-done";
          done.setAttribute("role", "status");
          var head = document.createElement("h3");
          head.textContent = "Danke, Sie stehen auf der Warteliste.";
          head.tabIndex = -1;
          var text = document.createElement("p");
          text.textContent = result.body.message || "Wir melden uns, wenn Belline in Ihrem Land startet. Eine E-Mail schicken wir Ihnen jetzt nicht.";
          done.appendChild(head);
          done.appendChild(text);
          form.parentNode.replaceChild(done, form);
          head.focus();
          return;
        }

        submit.disabled = false;
        submit.textContent = label;
        var field = result.body.field && form.elements[result.body.field];
        if (!field) {
          say(result.body.error || "Das hat nicht geklappt. Schreiben Sie uns an hello@belline.ai.", "bad");
          return;
        }
        if (result.body.confirmable) {
          fail(field, result.body.error, result.body.suggestion, function () {
            clear(field);
            send(true);
          });
        } else {
          fail(field, result.body.error, result.body.suggestion);
        }
        field.focus();
        say(result.body.confirmable ? "Bitte prüfen Sie kurz Ihre E-Mail-Adresse." : "Fast geschafft: Bitte korrigieren Sie das markierte Feld.", "bad");
      })
      .catch(function () {
        submit.disabled = false;
        submit.textContent = label;
        say("Wir konnten Belline gerade nicht erreichen. Versuchen Sie es gleich noch einmal, oder schreiben Sie an hello@belline.ai.", "bad");
      });
  }
})();