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
    document.removeEventListener("keydown", onKey);    document.dispatchEvent(new CustomEvent("belline:dock", { detail: { open: false } }));

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
    document.addEventListener("keydown", onKey);    document.dispatchEvent(new CustomEvent("belline:dock", { detail: { open: true } }));
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
  var veil = null;

  function close() {
    if (!dock) return;
    dock.remove();
    dock = null;
    if (veil) veil.remove();
    veil = null;
    fab.hidden = false;
    document.removeEventListener("keydown", onKey);    document.dispatchEvent(new CustomEvent("belline:dock", { detail: { open: false } }));

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

    // On a phone the dock is a sheet that slides up over the page (site.css):
    // the page stays behind it and the visitor stays where they were. The veil
    // is the "outside" a sheet needs to be dismissible by, and the grab handle
    // says which way it goes. Neither is drawn on a wide screen, where the
    // chat is a window in the corner and the page is beside it anyway.
    veil = document.createElement("div");
    veil.className = "chat-veil";
    veil.addEventListener("click", close);
    document.body.appendChild(veil);

    // A handle, not a second close button: × beside it is the one in the
    // accessibility tree, and two controls called "Close the chat" is one
    // control too many for anybody reading the page rather than looking at it.
    var grab = document.createElement("div");
    grab.className = "chat-grab";
    grab.setAttribute("aria-hidden", "true");
    grab.addEventListener("click", close);
    // A drag downwards closes it, as a sheet should; a drag up does nothing.
    var from = null;
    grab.addEventListener("pointerdown", function (e) {
      from = e.clientY;
      try {
        grab.setPointerCapture(e.pointerId);
      } catch (err) {
        /* capture is a nicety */
      }
    });
    grab.addEventListener("pointermove", function (e) {
      if (from !== null && e.clientY - from > 44) {
        from = null;
        close();
      }
    });
    grab.addEventListener("pointerup", function () {
      from = null;
    });

    dock.appendChild(frame);
    dock.appendChild(grab);
    dock.appendChild(shut);
    document.body.appendChild(dock);
    // Into the dock, so a keyboard is not left on the page behind it.
    shut.focus();
    document.addEventListener("keydown", onKey);    document.dispatchEvent(new CustomEvent("belline:dock", { detail: { open: true } }));
  }

  fab.addEventListener("click", open);
  fab.hidden = false;

  // "Write with Belle on belline.ai" from the WhatsApp page lands here with
  // ?chat=1. It used to land on #channels, a paragraph about the chat rather
  // than the chat.
  if (/[?&]chat=1(?:&|$)/.test(window.location.search)) open();
})();

/* --- the hero's card --------------------------------------------------------
   The three example conversations and the example calendar are four figures
   in the markup; here they become the tabs of one card, labelled from each
   figure's data-tab (so the German page names them in German). One is shown
   at a time and the visitor chooses: nothing rotates by itself. Without
   JavaScript the four stack, as they always could. */
(function () {
  var stage = document.querySelector(".stage[data-tabs]");
  if (!stage) return;
  var panels = [].slice.call(stage.children).filter(function (n) {
    return n.hasAttribute("data-tab");
  });
  if (panels.length < 2) return;

  var list = document.createElement("div");
  list.className = "stage-tabs";
  list.setAttribute("role", "tablist");
  list.setAttribute("aria-label", stage.getAttribute("data-tabs"));

  var tabs = panels.map(function (panel, i) {
    if (!panel.id) panel.id = "stage-panel-" + i;
    var tab = document.createElement("button");
    tab.type = "button";
    tab.className = "stage-tab";
    tab.id = panel.id + "-tab";
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", panel.id);
    tab.textContent = panel.getAttribute("data-tab");
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", tab.id);
    tab.addEventListener("click", function () {
      show(i, false);
    });
    list.appendChild(tab);
    return tab;
  });

  function show(index, focus) {
    tabs.forEach(function (tab, j) {
      var on = j === index;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      panels[j].classList.toggle("is-on", on);
    });
    if (focus) tabs[index].focus();
  }

  // Arrow keys move between tabs, as in any tab list.
  list.addEventListener("keydown", function (e) {
    var i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    var n = tabs.length;
    var next =
      e.key === "ArrowRight" ? (i + 1) % n :
      e.key === "ArrowLeft" ? (i - 1 + n) % n :
      e.key === "Home" ? 0 :
      e.key === "End" ? n - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    show(next, true);
  });

  stage.insertBefore(list, stage.firstChild);
  stage.classList.add("is-tabbed");
  show(0, false);
})();

/* --- the video receptionist ------------------------------------------------
   Belline's video receptionist, on our own site, once it is switched on for
   our own venue. When the venue's widget config says `video: true`, this loads
   embed-video.js from the app, which makes Belle's round bubble (a muted clip
   or a poster; no session, no microphone) and, on a tap, grows it into the
   call itself.

   One Belle, who travels (founder, 2026-09-18)
   --------------------------------------------
   There used to be two of her: a large bubble in the hero, and a separate
   floating launcher bottom right that appeared once the hero scrolled away.
   Two objects, one cross-fading into the other, and scrolling left her behind.

   Now there is one object. She rests in the hero at the call's own size, and
   as the hero's circle scrolls out of view she is carried to the bottom-right
   corner, shrinking as she goes, and lands there as the small face. Scrolling
   back up carries her home. While the hero's circle is on screen there is
   nothing in the corner, because there is nothing else to be there.

   - Tied to scroll position, not to a timer: each frame reads where the hero's
     slot is now and writes one transform on her and one on her circle. Nothing
     else changes while she flies — no width, no top, no left, no reflow — so
     the flight is a compositor job and the page never reflows under it.
   - `prefers-reduced-motion`: the trip is a step, not a flight. She rests in
     the hero exactly as she does for everybody else, and at the point the
     flight would have been mostly over she is simply in the corner, at the
     size she lands at, with nothing in between and no transition. She used to
     be cornered from the first paint instead, which cost every visitor with
     Windows' "Animation effects" off the hero's demonstration entirely.
   - Never mid-call. While a call is running the flight is off: the call keeps
     the picture-in-picture behaviour embed-video.js already has, and she never
     shrinks to a button with somebody talking to her.
   - × makes her small for the rest of the session: the hero's demonstration
     goes, and she stays landed in the corner wherever the page is scrolled.
   - She steps out of the way wherever the landed face (or her icons) would
     cover the pricing, a button or the hero's own words.

   WhatsApp is offered only while the config names a link (`whatsappLink`: a
   connected number, or belline.ai's public one, SITE_WHATSAPP_NUMBER), and it
   opens that link.

   With video off, or if embed-video.js never arrives, the three floating
   buttons stay and every "Talk to Belle" rings Belline's voice call. */
(function () {
  var chatFab = document.querySelector("[data-chat]");
  var chatUrl = chatFab ? chatFab.getAttribute("data-chat") || "" : "";
  var match = /^(https?:\/\/[^/]+)\/embed\/([^/]+)\/chat$/.exec(chatUrl);

  /**
   * The room the page painted for Belle, given up.
   *
   * A build with video live paints the layout the bubble will make rather
   * than the one it will replace: `body.video-pending` (site.css) holds the
   * hero's heading, paragraph, "Talk to Belle" and the three floating buttons
   * back, and holds the slot at the bubble's own size. That promise is kept
   * by exactly two callers, once between them:
   *
   *   `place` — she is here. `has-bubble` and `has-video-bubble` hold the
   *   same things back from now on, and her real icons take the room.
   *   `noBubble` — she is not coming (video off, the config refused, the
   *   config never answered, or embed-video.js did not load). The hero's own
   *   heading, button and floating buttons appear, and that is the page.
   *
   * Whichever runs first wins: a config that answers after the deadline still
   * mounts her, and a failure after she is placed changes nothing.
   */
  var settled = false;
  /**
   * How long the page holds her place before giving up on the config.
   *
   * The config is a few hundred bytes from app.belline.ai and answers in well
   * under a second; this is only so that a request which never answers at all
   * cannot leave the hero without its heading and its button for good.
   */
  var DECIDE_MS = 4000;
  var deadline = 0;

  function keptFor(who) {
    if (settled) return false;
    settled = true;
    if (deadline) window.clearTimeout(deadline);
    document.body.classList.remove("video-pending");
    return who === "none";
  }

  /** There will be no bubble: the hero's own demonstration is the page. */
  function noBubble() {
    if (!keptFor("none")) return;
    var demo = document.querySelector(".hero-demo");
    if (demo) demo.classList.remove("has-video-hero");
  }

  if (!chatFab || typeof window.fetch !== "function" || !match) return noBubble();
  var appOrigin = match[1];
  var key = match[2];
  deadline = window.setTimeout(noBubble, DECIDE_MS);

  var ctl = null;
  var bubble = null;
  var circle = null;
  var waFab = document.querySelector(".wa-fab");
  /** The config's WhatsApp link, or null while there is no number to offer. */
  var waLink = null;
  var figure = document.querySelector("[data-hero-video]");
  var slot = figure ? figure.querySelector("[data-video-slot]") : null;
  var heroDemo = figure ? figure.closest(".hero-demo") : null;
  var docked = false;
  var inCall = false;
  var poster = "";

  /** The diameter of the landed face. */
  var SMALL = 64;
  /** A phone, where the hero is a column rather than two. */
  var PHONE = "(max-width: 900px)";
  /**
   * Does she make the trip on a phone too?
   *
   * The founder's guess was no — the hero is too tall there for the flight to
   * read. Checked at 390x844 before this was written: her circle is 240px in a
   * 844px screen and the flight takes about 230px of scrolling, a quarter of a
   * screen, which reads perfectly well; and starting her in the corner costs
   * the phone its whole hero demonstration, which is the strongest thing on
   * that screen. So she travels on a phone too. Set this false to try the
   * other way round — nothing else has to change.
   */
  var PHONE_TRAVELS = true;

  var WORDS = SITE_DE
    ? { face: "Mit Belle per Video sprechen", caption: "Hallo, ich bin Belle — zum Sprechen tippen", region: "Belle, KI-Empfang" }
    : { face: "Talk to Belle on video", caption: "Hi, I'm Belle — tap to talk", region: "Belle, AI receptionist" };

  // Until the config names a number, there is no WhatsApp to offer.
  if (waFab) waFab.hidden = true;

  function actions() {
    var list = [];
    // Chat first: the quiet way in for somebody who cannot talk out loud now.
    list.push({ kind: "chat", label: SITE_DE ? "Mit Belle chatten" : "Chat with Belle", run: function () { chatFab.click(); } });
    // WhatsApp only while the config names a number.
    if (waFab && waLink) list.push({ kind: "whatsapp", label: SITE_DE ? "Belle auf WhatsApp" : "WhatsApp Belle", run: function () { waFab.click(); } });
    return list;
  }

  /** The floating WhatsApp button, straight to the number the config names. */
  function offerWhatsApp() {
    if (!waFab || !waLink) return;
    waFab.setAttribute("href", waLink);
    waFab.setAttribute("target", "_blank");
    waFab.setAttribute("rel", "noopener");
    waFab.hidden = false;
  }

  function cssUrl(url) {
    return 'url("' + String(url).replace(/["\\\n\r]/g, encodeURIComponent) + '")';
  }

  function query(q) {
    try {
      return Boolean(window.matchMedia && window.matchMedia(q).matches);
    } catch (e) {
      return false;
    }
  }

  function inHero() {
    return Boolean(figure && figure.classList.contains("has-bubble"));
  }

  /** × was pressed in this tab's session: Belle stays landed in the corner. */
  function small() {
    return Boolean(ctl && ctl.state().dismissed);
  }

  /**
   * Does she make the trip on this screen at all?
   *
   * Only PHONE_TRAVELS decides, and it says yes; see the note beside it.
   *
   * Reduced motion used to answer yes here: she was simply in the corner from
   * the first paint and the hero kept a still portrait of her instead. That
   * is what the founder saw on Windows 11 in Edge with "Animation effects"
   * off (2026-09-19) — Belle never moved, because she was never in the hero
   * to move from, and every desktop visitor with that setting was handed a
   * 64px face in the corner and never met the demonstration the hero is for.
   * Reduced motion means less animation, not less product. She rests in the
   * hero there too now, and `stepped` takes the motion out of the trip
   * instead of taking the trip away.
   */
  function cornerOnly() {
    return !PHONE_TRAVELS && query(PHONE);
  }

  /**
   * Reduced motion: she is in one place or the other, never in between.
   *
   * The trip stops being a flight and becomes a switch. She is in the hero
   * until the scroll has carried her most of the way, and then she is in the
   * corner — one step, at the size she lands at, with no frames between and
   * no transition (site.css turns the landing transition off under the same
   * query). Everything else is the same: the same two places, the same scroll
   * positions, the same behaviour for ×, for a call and for the corner's
   * stepping aside.
   */
  function stepped() {
    return query("(prefers-reduced-motion: reduce)");
  }

  /**
   * The flight's progress, or the step's.
   *
   * The dead band matters: without it a scroll that rests near the switching
   * point would put her in the corner and back in the hero on alternate
   * frames, which is more motion than the flight it replaced, not less.
   */
  function maybeStep(p) {
    if (!stepped()) return p;
    if (p >= 0.6) return 1;
    if (p <= 0.4) return 0;
    return progress >= 0.999 ? 1 : 0;
  }

  // --- where she is ----------------------------------------------------------

  /** 0 while she rests in the hero, 1 once she has landed in the corner. */
  var progress = 0;
  /** "hero" (in the page's flow), "flight" (carried), "corner" (landed). */
  var where = "hero";
  /** position:fixed and carried by a transform. False means she is in the hero's flow. */
  var flying = false;
  var tucked = false;
  var away = false;
  /** The slot's own top padding, so her resting place can be found without measuring her. */
  var slotPad = 0;
  /** env(safe-area-inset-bottom), measured once — a corner on an iPhone is not the screen's corner. */
  var safeBottom = 0;
  var slotSides = 0;
  var slotLeftPad = 0;
  /** What she must not land on. Re-read when the page changes size, not every frame. */
  var obstacles = [];
  var heroText = [];
  var textPad = [];
  /** The last time the landed face checked what is under it. */
  var checkedAt = 0;

  // What the landed face must never sit on: the pricing, and any button or form.
  var AVOID =
    "#price .sec-head, #price .market-note, #price .price-bar, #price .plans, #price .plan-shared, #price .price-tax, #price .compare, #price .terms, " +
    ".btn, .nav-cta, .cta-row, .roi-result, #warteliste, .chat-dock, .call-dock";
  /** The hero's words: never under her either. Their content box only. */
  var HERO_TEXT = ".hero .lead, .hero-note";

  function measureOnce() {
    try {
      var probe = document.createElement("div");
      probe.style.cssText = "position:fixed;left:-9999px;bottom:0;width:1px;height:env(safe-area-inset-bottom,0px)";
      document.body.appendChild(probe);
      safeBottom = probe.offsetHeight || 0;
      probe.remove();
    } catch (e) {
      safeBottom = 0;
    }
  }

  /**
   * Everything a frame would otherwise have to ask the page for.
   *
   * Read when the page changes shape, never inside the flight: a frame that
   * calls getComputedStyle or querySelectorAll is a frame that can miss.
   */
  function remeasure() {
    var style = slot ? window.getComputedStyle(slot) : null;
    slotPad = style ? parseFloat(style.paddingTop) || 0 : 0;
    slotSides = style ? (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0) : 0;
    slotLeftPad = style ? parseFloat(style.paddingLeft) || 0 : 0;
    obstacles = [].slice.call(document.querySelectorAll(AVOID)).concat([].slice.call(document.querySelectorAll(HERO_TEXT)));
    heroText = [].slice.call(document.querySelectorAll(HERO_TEXT));
    textPad = heroText.map(function (el) {
      return parseFloat(window.getComputedStyle(el).paddingRight) || 0;
    });
  }

  function clamp(n) {
    return n < 0 ? 0 : n > 1 ? 1 : n;
  }

  /** The circle's laid-out width — its transform scales it, and never this. */
  function circleWidth() {
    return (circle && circle.offsetWidth) || 0;
  }

  /**
   * How far along the trip the page's scroll has carried her.
   *
   * Read from where the hero's slot is right now, so she is carried by the
   * scroll rather than reacting to it: the flight begins as her circle reaches
   * the top of the screen and finishes once three quarters of it has gone past.
   */
  function progressNow() {
    if (!slot) return 1;
    var size = circleWidth();
    if (!size) return 0;
    var r = slot.getBoundingClientRect();
    if (!r.height) return 0;
    var head = window.innerHeight * 0.06;
    var span = size * 0.75 + head;
    return clamp((head - (r.top + slotPad)) / span);
  }

  function overlaps(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  /** Is anything of the page's own under this box? */
  function hits(box) {
    for (var i = 0; i < obstacles.length; i++) {
      var el = obstacles[i];
      if (bubble && bubble.contains(el)) continue;
      var r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) continue;
      // The room site.css leaves beside the hero's words counts as room.
      var at = heroText.indexOf(el);
      var pad = at < 0 ? 0 : textPad[at];
      if (overlaps(box, { left: r.left, top: r.top, right: r.right - pad, bottom: r.bottom })) return true;
    }
    return false;
  }

  /** How far to the left of the landed face her icons reach. */
  function rowReach() {
    var row = bubble ? bubble.querySelector(".bvb-row") : null;
    return row ? row.offsetWidth + 10 : 0;
  }

  function travelOn() {
    if (flying || !bubble) return;
    // Keep the room she took, measured before she leaves the flow, so the hero
    // does not jump as she lifts off.
    if (slot && inHero() && !slot.style.minHeight) slot.style.minHeight = slot.offsetHeight + "px";
    flying = true;
    bubble.classList.add("vb-travel");
  }

  function travelOff() {
    if (!bubble) return;
    if (flying) {
      flying = false;
      bubble.classList.remove("vb-travel", "vb-tucked", "vb-away");
      bubble.style.transform = "";
      if (circle) circle.style.transform = "";
      if (slot && !bubble.classList.contains("vb-float")) slot.style.minHeight = "";
    }
    tucked = false;
    away = false;
    if (where !== "hero") {
      where = "hero";
      bubble.setAttribute("data-vb", "hero");
    }
  }

  /** Write the frame: one transform on her, one on her circle, and nothing else. */
  function carry(p) {
    progress = p;
    if (p <= 0) return travelOff();
    travelOn();

    var vw = window.innerWidth || 0;
    var vh = window.innerHeight || 0;
    var margin = vw <= 900 ? 20 : 24;
    var size = circleWidth() || SMALL;
    var landed = p >= 0.999;

    // Where she lands, and whether she has to step aside to do it. Only once
    // she has landed, and at most ten times a second: she is not moving there,
    // and measuring forty boxes on every frame of a flight is how a flight
    // drops below sixty.
    var cornerX = vw - margin - SMALL;
    var cornerY = vh - margin - SMALL - safeBottom;
    if (!landed) {
      tucked = false;
      away = false;
    } else {
      var now = Date.now();
      if (where !== "corner" || now - checkedAt > 100) {
        checkedAt = now;
        tucked = false;
        away = false;
        var withRow = { left: cornerX - rowReach(), top: cornerY, right: cornerX + SMALL, bottom: cornerY + SMALL };
        if (hits(withRow)) {
          tucked = true;
          if (hits({ left: vw - 12 - SMALL, top: cornerY, right: vw - 12, bottom: cornerY + SMALL })) away = true;
        }
      }
      if (tucked) cornerX = vw - 12 - SMALL;
    }

    var x = cornerX;
    var y = cornerY + (away ? SMALL + 40 : 0);
    var s = SMALL / size;
    if (!landed && slot && inHero()) {
      // Everything but the slot's own position was read in `remeasure`.
      var r = slot.getBoundingClientRect();
      var hx = r.left + slotLeftPad + (r.width - slotSides - bubble.offsetWidth) / 2;
      var hy = r.top + slotPad;
      x = hx + (cornerX - hx) * p;
      y = hy + (cornerY - hy) * p;
      s = 1 + (SMALL / size - 1) * p;
    }

    bubble.style.transform = "translate3d(" + Math.round(x) + "px," + Math.round(y) + "px,0)";
    if (circle) circle.style.transform = "scale(" + s.toFixed(4) + ")";
    bubble.classList.toggle("vb-tucked", tucked);
    bubble.classList.toggle("vb-away", away);

    var next = landed ? "corner" : "flight";
    if (where !== next) {
      where = next;
      bubble.setAttribute("data-vb", next);
    }
  }

  function update() {
    if (!bubble || !ctl) return;
    // A call keeps whatever embed-video.js is doing with it, including
    // carrying it as the page scrolls. She is never flown to a button mid-call.
    //
    // Hidden behind a dock, she is left exactly as she is: putting her back in
    // the hero's flow would give the slot's reserved height back, the page
    // would get shorter under the visitor, and closing the chat would leave
    // them somewhere they had never scrolled to.
    if (inCall || docked) return;
    if (bubble.classList.contains("vb-float")) return;
    carry(cornerOnly() || small() || !inHero() ? 1 : maybeStep(progressNow()));
  }

  var queued = false;
  function soon() {
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(function () {
      queued = false;
      update();
    });
  }

  // --- placing her -----------------------------------------------------------

  function place(root) {
    bubble = root;
    circle = root.querySelector(".bvb-circle");
    root.classList.add("video-bubble");
    root.setAttribute("data-vb", "hero");
    document.body.classList.add("has-video-bubble");
    if (slot && !cornerOnly()) {
      slot.appendChild(root);
      figure.classList.add("has-bubble");
      if (heroDemo) heroDemo.classList.add("has-video-hero");
    } else {
      document.body.appendChild(root);
      // Corner from the first paint (reduced motion, or a phone that does not
      // travel): the hero would otherwise keep its own still portrait of the
      // same face, so the visitor meets two Belles at once, one of them inert.
      // The hero figure goes, exactly as it does when × lands her.
      if (figure) figure.classList.add("is-small");
      if (heroDemo) heroDemo.classList.remove("has-video-hero");
    }
    // She is in the page: the classes above hold back everything
    // `video-pending` was holding back, and her own icons take its room.
    keptFor("bubble");
    remeasure();
    // Made small earlier in this session: landed, not in the hero.
    if (root.getAttribute("data-state") === "mini") shrink();
    update();
  }

  /** The hero's demonstration goes, and she stays landed in the corner. */
  function shrink() {
    if (!bubble) return;
    if (bubble.parentNode !== document.body) document.body.appendChild(bubble);
    if (figure) {
      figure.classList.remove("has-bubble");
      figure.classList.add("is-small");
    }
    // site.css keeps the hero's words clear of the corner on a small phone.
    document.body.classList.add("belle-small");
    if (heroDemo) heroDemo.classList.remove("has-video-hero");
    if (slot) slot.style.minHeight = "";
  }

  /** The screen changed shape: she may have to change where she lives. */
  function reconsider() {
    if (!bubble) return;
    var corner = cornerOnly() || small();
    if (corner && inHero()) {
      travelOff();
      if (bubble.parentNode !== document.body) document.body.appendChild(bubble);
      figure.classList.remove("has-bubble");
      // Reduced motion turned on mid-visit, or the window became a phone: she
      // lands, and the hero's still portrait of her goes with her (see place).
      // `small()` already reached here through shrink(), which does the same.
      if (cornerOnly()) figure.classList.add("is-small");
      if (heroDemo) heroDemo.classList.remove("has-video-hero");
      if (slot) slot.style.minHeight = "";
    } else if (!corner && slot && !inHero() && (!figure.classList.contains("is-small") || !small())) {
      // She may come home: either the hero figure was never hidden, or it was
      // hidden only because she was cornered from the start and that reason has
      // gone (reduced motion switched off, the window widened). × is the one
      // reason that persists — `small()` — and it keeps her in the corner.
      figure.classList.remove("is-small");
      travelOff();
      slot.appendChild(bubble);
      figure.classList.add("has-bubble");
      if (heroDemo) heroDemo.classList.add("has-video-hero");
    }
    remeasure();
    update();
  }

  // --- the call ---------------------------------------------------------------

  /**
   * The call in the corner, where the visitor is. The hero keeps the room her
   * face took, so the page does not jump while she floats.
   */
  function float() {
    if (!bubble || bubble.classList.contains("vb-float")) return;
    // Back into the hero's flow first, then keep the room she took: travelOff
    // releases the reserved height, so reserving it before would undo it.
    travelOff();
    if (slot && inHero()) slot.style.minHeight = slot.offsetHeight + "px";
    bubble.classList.remove("vb-leaving");
    bubble.classList.add("vb-float");
  }

  function startCall() {
    if (!ctl || !bubble) return;
    // Grown where she is: in the hero while she is resting there, otherwise
    // floating in the corner she had travelled to.
    if (small() || !inHero() || progress > 0.02) float();
    inCall = true;
    ctl.openCall();
  }

  function callClosed() {
    inCall = false;
    if (!bubble) return;
    // A call that happened where she rests: she is already where she belongs,
    // and the scroll decides the rest.
    if (!bubble.classList.contains("vb-float")) {
      if (slot && inHero()) slot.style.minHeight = "";
      update();
      return;
    }
    // A call that floated: out of sight at once, but still rendered while the
    // frame ends its session (embed-video.js gives it END_GRACE_MS) — a frame
    // under display:none may never get to stop the microphone.
    var leaving = bubble;
    leaving.classList.add("vb-leaving");
    window.setTimeout(function () {
      leaving.classList.remove("vb-leaving");
      if (inCall) return;
      leaving.classList.remove("vb-float");
      if (slot) slot.style.minHeight = "";
      // Back to wherever the page's scroll says she should be by now.
      update();
      // Where the visitor is, so focus is never sent off screen.
      try {
        leaving.querySelector(".bvb-circle").focus({ preventScroll: true });
      } catch (e) {
        /* focus is a nicety */
      }
    }, 600);
  }

  function ready(api) {
    ctl = api.mount({
      env: window,
      config: window.__bellineVideoConfig || {},
      origin: appOrigin,
      key: key,
      hostOrigin: location.origin,
      // In the hero's flow; this file carries her to the corner and site.css floats a call.
      fixed: false,
      ring: true,
      // The face is the button: no "Talk to Belle" under it.
      talkButton: false,
      strings: { face: WORDS.face, caption: WORDS.caption },
      actions: actions,
      place: place,
      onDismissed: function () {
        shrink();
        update();
      },
      onCallOpened: function () {
        inCall = true;
        update();
      },
      onCallClosed: callClosed,
      // Grown back from picture in picture while her place in the hero is off screen: in the corner, not out of view.
      onPip: function (on) {
        if (!on && inHero() && progressNow() > 0.02) float();
      },
      // "Type instead" during a call: the chat opens where the bubble was.
      onSwitch: function (to) {
        if (to === "chat") chatFab.click();
      },
    });
    measureOnce();
    remeasure();
    window.addEventListener("scroll", soon, { passive: true });
    // A phone's address bar sliding away is a resize, and it arrives with the
    // scrolling: one frame's worth at a time, never a measurement per event.
    var resizing = false;
    window.addEventListener("resize", function () {
      if (resizing) return;
      resizing = true;
      window.requestAnimationFrame(function () {
        resizing = false;
        reconsider();
      });
    });
    try {
      window.matchMedia(PHONE).addEventListener("change", reconsider);
      window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", reconsider);
    } catch (e) {
      /* an older browser keeps the screen it loaded with */
    }
    update();
  }

  // The chat and the voice call dock in the corner: Belle steps out of their
  // way while one is open, and comes back when it closes.
  document.addEventListener("belline:dock", function (e) {
    docked = Boolean(e.detail && e.detail.open);
    if (ctl) ctl.setHidden(docked);
    update();
  });

  // Every "Talk to Belle" on the page starts the video call in Belle's circle
  // once she is here. Caught before the voice dock's own listener; until then,
  // and without video, they ring the voice call.
  document.addEventListener(
    "click",
    function (e) {
      if (!ctl || docked) return;
      var trigger = e.target && e.target.closest ? e.target.closest("[data-call]") : null;
      if (!trigger) return;
      e.preventDefault();
      e.stopPropagation();
      startCall();
    },
    true
  );

  /**
   * Her own face is the button, and embed-video.js opens the call from it
   * directly. Caught here first, in the capture phase, so that a call started
   * while she has travelled grows where the visitor is looking rather than
   * back up in the hero — and so the frame's own grow-from-here measurement
   * (embed-video.js `resize`) is taken after she has been put in the corner,
   * not before.
   */
  document.addEventListener(
    "click",
    function (e) {
      if (!ctl || docked || inCall || !bubble) return;
      var face = e.target && e.target.closest ? e.target.closest(".bvb-circle") : null;
      if (!face || !bubble.contains(face)) return;
      if (small() || !inHero() || progress > 0.02) float();
    },
    true
  );

  fetch(appOrigin + "/api/embed/" + key + "/config", { mode: "cors" })
    .then(function (r) {
      return r.ok ? r.json() : null;
    })
    .then(function (cfg) {
      if (!cfg) return noBubble();
      waLink = typeof cfg.whatsappLink === "string" && /^https:\/\/wa\.me\//.test(cfg.whatsappLink) ? cfg.whatsappLink : null;
      if (cfg.video !== true) {
        // The floating buttons are the way in on this page, so they come back
        // before WhatsApp is offered among them.
        noBubble();
        offerWhatsApp();
        return;
      }
      offerWhatsApp();
      window.__bellineVideoConfig = cfg.videoBubble || {};
      var still = window.__bellineVideoConfig.posterUrl;
      if (typeof still === "string" && still) poster = still.charAt(0) === "/" && still.charAt(1) !== "/" ? appOrigin + still : still;
      if (figure) {
        var face = figure.querySelector(".hv-face");
        if (face && poster) {
          face.style.backgroundImage = cssUrl(poster);
          figure.classList.add("has-poster");
        }
      }
      if (window.BellineVideo) return ready(window.BellineVideo);
      (window.__bellineVideoReady = window.__bellineVideoReady || []).push(ready);
      var s = document.createElement("script");
      s.src = appOrigin + "/embed-video.js";
      s.async = true;
      s.onerror = noBubble;
      document.head.appendChild(s);
    })
    .catch(function () {
      // No bubble is the right failure, and the hero's own demonstration and
      // the floating buttons are what the page has instead.
      noBubble();
    });
})();
/* --- monthly / annual ------------------------------------------------------
   The prices for both cycles are already in the markup as data attributes, so
   the page reads correctly with no JavaScript at all and this only swaps
   between two sets of numbers that are both already true.

   The choice travels: every link to the checkout on the page (the plan cards,
   and every "Get started") carries `cycle=annual` while Annual is chosen, and
   drops it again for Monthly. The checkout reads `?cycle=annual`. */
(function () {
  var group = document.querySelector(".cycle");
  if (!group) return;

  var options = group.querySelectorAll(".cycle-opt");

  function carry(cycle) {
    document.querySelectorAll('a[href*="/checkout"]').forEach(function (a) {
      try {
        var url = new URL(a.getAttribute("href"), location.href);
        if (!/\/checkout\/?$/.test(url.pathname)) return;
        if (cycle === "annual") url.searchParams.set("cycle", "annual");
        else url.searchParams.delete("cycle");
        a.setAttribute("href", url.toString());
      } catch (e) {
        /* a link we cannot parse keeps its own href */
      }
    });
  }

  function show(cycle) {
    options.forEach(function (opt) {
      var on = opt.getAttribute("data-cycle") === cycle;
      opt.classList.toggle("is-on", on);
      opt.setAttribute("aria-pressed", String(on));
    });
    document.querySelectorAll("[data-" + cycle + "]").forEach(function (el) {
      el.textContent = el.getAttribute("data-" + cycle);
    });
    carry(cycle);
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
  // The German pages call it "warteliste" and the English location pages call
    // it "waitlist", because each page's markup is written in its own language.
    // This looked for the German id alone, so every English waitlist page
    // shipped with `novalidate` and nothing bound to it: an empty submit left
    // the site for an unstyled error page on another origin.
    var form = document.getElementById("warteliste") || document.getElementById("waitlist");
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