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
    dock.setAttribute("aria-label", "Call with Belline");

    var frame = document.createElement("iframe");
    frame.src = bell.getAttribute("href");
    frame.title = "Call with Belline";
    // Without this the microphone is blocked inside the frame and the call is
    // silent with no error a visitor could act on.
    frame.allow = "microphone";
    frame.className = "call-frame";

    var shut = document.createElement("button");
    shut.type = "button";
    shut.className = "call-shut";
    shut.setAttribute("aria-label", "Close the call");
    shut.textContent = "×";
    shut.addEventListener("click", close);

    dock.appendChild(frame);
    dock.appendChild(shut);
    document.body.appendChild(dock);
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
    dock.setAttribute("aria-label", "Chat with Belline");

    var frame = document.createElement("iframe");
    // Our origin goes in the URL so the edge can name it in frame-ancestors.
    // Without it the browser refuses the page before it is parsed.
    frame.src =
      fab.getAttribute("data-chat") + "?o=" + encodeURIComponent(location.origin);
    frame.title = "Chat with Belline";
    frame.className = "chat-frame";
    // For the voice note. The browser asks only when the visitor holds the
    // microphone button inside the chat, never on opening.
    frame.allow = "microphone";

    var shut = document.createElement("button");
    shut.type = "button";
    shut.className = "call-shut";
    shut.setAttribute("aria-label", "Close the chat");
    shut.textContent = "×";
    shut.addEventListener("click", close);

    dock.appendChild(frame);
    dock.appendChild(shut);
    document.body.appendChild(dock);
    document.addEventListener("keydown", onKey);
  }

  fab.addEventListener("click", open);
  fab.hidden = false;
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

/* --- the buy bar -----------------------------------------------------------
   On a phone the purchase has to be reachable from anywhere on the page. But
   a bar that is there from the first frame covers the headline that is meant
   to sell it, so it arrives once the hero is behind you and the visitor has
   chosen to keep reading.

   A class on <html> rather than an inline style, so the whole behaviour —
   including the bell stepping aside — lives in the stylesheet. */
(function () {
  var hero = document.querySelector(".hero");
  if (!hero || !document.querySelector(".buybar")) return;

  if (!("IntersectionObserver" in window)) {
    document.documentElement.classList.add("buybar-on");
    return;
  }

  new IntersectionObserver(
    function (entries) {
      document.documentElement.classList.toggle("buybar-on", !entries[0].isIntersecting);
    },
    { rootMargin: "-72px 0px 0px 0px" },
  ).observe(hero);
})();
