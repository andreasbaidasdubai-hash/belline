/**
 * Belline site behaviour. Shared by the landing page and every vertical page.
 *
 * Two pieces: the call panel in the hero, and the mobile menu. Both are
 * deliberately plain — no framework, no build step, and nothing here runs
 * before the markup it enhances already reads correctly.
 */

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
    return; // The static markup below it still reads fine.
  }
  if (!scenes || !scenes.length) return;

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

  /** The whole scene at once — the resting state, and the reduced-motion one. */
  function paintAll(scene) {
    body.textContent = "";
    scene.turns.forEach(function (t) {
      body.appendChild(turnEl(t[0], t[1]));
    });
    body.appendChild(outcomeEl(scene.outcome));
    statusEl.textContent = scene.outcome.human ? "Transferred" : "Booked";
    call.setAttribute("data-speaking", "false");
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
        statusEl.textContent = scene.outcome.human ? "Transferred" : "Booked";
        body.appendChild(outcomeEl(scene.outcome));
        setListening(false);
        return;
      }
      var turn = scene.turns[i];
      var isAgent = turn[0] === "agent";
      call.setAttribute("data-speaking", String(isAgent));
      statusEl.textContent = isAgent
        ? i > 0 && !scene.outcome.human
          ? "Checking the book"
          : "Answered"
        : "Listening";
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
      player.src = "/audio/" + scene.audio[i];
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
    if (audible && scene.audio) {
      playAudible(scene);
      return;
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

    body.textContent = "";
    statusEl.textContent = "Ringing";
    call.setAttribute("data-speaking", "false");

    var at = 520;
    scene.turns.forEach(function (t, i) {
      timers.push(
        setTimeout(function () {
          if (t[0] === "agent") {
            call.setAttribute("data-speaking", "true");
            // A caller who has just named a date hears a real pause while the
            // book is checked. Saying so is more honest than a spinner, and
            // it is the step this category tends to skip.
            statusEl.textContent = i > 0 && !scene.outcome.human ? "Checking the book" : "Answered";
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
        statusEl.textContent = scene.outcome.human ? "Transferred" : "Booked";
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
})();

/* --- mobile menu ---------------------------------------------------------- */
(function () {
  var toggle = document.querySelector(".menu-toggle");
  var nav = document.getElementById("site-nav");
  if (!toggle || !nav) return;

  function setOpen(open) {
    nav.setAttribute("data-open", String(open));
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  }

  toggle.addEventListener("click", function () {
    setOpen(nav.getAttribute("data-open") !== "true");
  });

  // Tapping a link should close the panel behind it, or the next page loads
  // underneath an open menu.
  nav.addEventListener("click", function (e) {
    if (e.target.tagName === "A") setOpen(false);
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") setOpen(false);
  });

  // Must track the CSS breakpoint, or the panel stays open and orphaned when
  // a rotating tablet crosses back into the desktop header.
  window.matchMedia("(min-width: 901px)").addEventListener("change", function (e) {
    if (e.matches) setOpen(false);
  });
})();
