(() => {
  "use strict";

  const telegram = window.Telegram?.WebApp;
  telegram?.ready();
  telegram?.expand();
  const supportsHaptics = telegram?.isVersionAtLeast?.("6.1") || false;
  const themeColors = {
    bg_color: "--app-bg",
    secondary_bg_color: "--app-panel",
    text_color: "--app-text",
    hint_color: "--app-hint",
    button_color: "--app-accent",
    button_text_color: "--app-button-text"
  };

  Object.entries(themeColors).forEach(([themeKey, cssProperty]) => {
    const color = telegram?.themeParams?.[themeKey];
    if (typeof color === "string" && /^#[\da-f]{6}$/i.test(color)) {
      document.documentElement.style.setProperty(cssProperty, color);
    }
  });
  const themeBackground = telegram?.themeParams?.bg_color;
  if (typeof themeBackground === "string" && /^#[\da-f]{6}$/i.test(themeBackground)) {
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeBackground);
  }

  const apiBase = document.querySelector('meta[name="api-base-url"]')?.content.trim().replace(/\/$/, "") || "";
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const panels = [...document.querySelectorAll('[role="tabpanel"]')];

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((item) => {
        const selected = item === tab;
        item.setAttribute("aria-selected", String(selected));
        item.classList.toggle("text-muted", !selected);
      });
      panels.forEach((panel) => panel.classList.toggle("hidden", panel.id !== tab.getAttribute("aria-controls")));
    });
  });

  function linesFrom(element) {
    return element.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  }

  function validateChoices(element, statusElement) {
    const choices = linesFrom(element);
    if (choices.length < 2 || choices.length > 10) {
      statusElement.textContent = "Enter 2 to 10 non-empty choices.";
      return null;
    }
    statusElement.textContent = "";
    return choices;
  }

  function randomItem(items) {
    return items[Math.floor(Math.random() * items.length)];
  }

  const foodForm = document.querySelector("#food-form");
  const foodStatus = document.querySelector("#food-status");
  const placeResult = document.querySelector("#place-result");
  let sharedCoordinates = null;
  let decisionSession = null;

  async function requestJson(path, options = {}) {
    const response = await fetch(`${apiBase}${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Request failed.");
    return data;
  }

  function searchPayload(type = "food", locationField = "#location") {
    return {
      location: document.querySelector(locationField).value.trim(),
      coordinates: locationField === "#location" ? sharedCoordinates : null,
      type,
      budget: document.querySelector("#budget-filter").value,
      craving: document.querySelector("#craving-filter").value,
      dietary: document.querySelector("#dietary-filter").value
    };
  }

  function saveDecisionSession() {
    if (decisionSession) sessionStorage.setItem("jom-decide-pick", JSON.stringify(decisionSession));
  }

  function appendPlaceDetails(container, place, compact = false) {
    const title = document.createElement("h3");
    title.className = compact ? "font-extrabold" : "text-xl font-extrabold";
    title.textContent = place.name;
    container.append(title);

    const category = document.createElement("p");
    category.className = "mt-1 text-sm font-bold text-lime";
    category.textContent = place.category;
    container.append(category);

    const details = document.createElement("p");
    details.className = "mt-2 text-sm text-muted";
    const distance = Number.isFinite(place.distanceKm) ? `${place.distanceKm} km away` : place.area;
    const dietary = place.halal ? " · Halal tagged" : place.porkFree ? " · Pork-free tagged" : "";
    details.textContent = `${distance} · Est. RM${place.budgetEstimate}/person · ${place.openStatus}${dietary}`;
    container.append(details);

    const navigation = document.createElement("div");
    navigation.className = "mt-4 flex flex-wrap gap-2";
    [
      { url: place.wazeUrl, label: "🚗 Open in Waze", style: "border border-white/15" },
      { url: place.googleMapsUrl, label: "🗺️ Open in Google Maps", style: "bg-white text-ink" }
    ].forEach(({ url, label, style }) => {
      if (!url) return;
      const link = document.createElement("a");
      link.className = `inline-flex rounded-xl px-3 py-2 text-sm font-extrabold ${style}`;
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = label;
      navigation.append(link);
    });
    container.append(navigation);
  }

  document.querySelector("#share-location").addEventListener("click", () => {
    if (!navigator.geolocation) {
      foodStatus.textContent = "This device does not support location sharing.";
      return;
    }

    foodStatus.textContent = "Finding your location…";
    navigator.geolocation.getCurrentPosition(
      (position) => {
        sharedCoordinates = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude
        };
        document.querySelector("#location").value = "";
        foodStatus.textContent = "Location ready. Tap “Pick my spot”.";
      },
      () => {
        foodStatus.textContent = "Could not get location. Enter your area instead.";
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 }
    );
  });

  document.querySelector("#location").addEventListener("input", () => {
    sharedCoordinates = null;
  });

  foodForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const location = document.querySelector("#location").value.trim();
    if (!location && !sharedCoordinates) {
      foodStatus.textContent = "Enter an area or use GPS.";
      return;
    }

    placeResult.classList.add("hidden");
    decisionSession = null;
    sessionStorage.removeItem("jom-decide-pick");
    foodStatus.textContent = "Finding nearby places…";
    const submitButton = foodForm.querySelector('[type="submit"]');
    submitButton.disabled = true;

    try {
      const data = await requestJson("/api/places", {
        method: "POST",
        body: JSON.stringify(searchPayload(document.querySelector("#place-type").value))
      });
      const first = randomItem(data.places);
      decisionSession = { places: data.places, first, current: first, rerolls: 0 };
      saveDecisionSession();
      renderPlace(decisionSession.first);
      foodStatus.textContent = "Decision made. Enjoy!";
    } catch (error) {
      foodStatus.textContent = error.message || "Could not reach the server. Check your connection.";
    } finally {
      submitButton.disabled = false;
    }
  });

  function renderPlace(place) {
    placeResult.replaceChildren();
    appendPlaceDetails(placeResult, place);

    if (decisionSession && decisionSession.places.length > 1) {
      const rejectButton = document.createElement("button");
      rejectButton.className = "mt-4 w-full rounded-xl border border-lime/50 px-4 py-3 font-extrabold text-lime";
      rejectButton.type = "button";
      rejectButton.textContent = decisionSession.rerolls === 0 ? "Not this one? Re-roll once" : "Reject again — lock first pick";
      rejectButton.addEventListener("click", () => {
        if (decisionSession.rerolls === 0) {
          decisionSession.rerolls = 1;
          const alternatives = decisionSession.places.filter((candidate) => candidate.id !== decisionSession.first.id);
          decisionSession.current = randomItem(alternatives);
          saveDecisionSession();
          renderPlace(decisionSession.current);
          foodStatus.textContent = "Last re-roll used. Reject again to lock the first pick.";
          return;
        }
        decisionSession.rerolls = 2;
        decisionSession.current = decisionSession.first;
        saveDecisionSession();
        renderPlace(decisionSession.first);
        foodStatus.textContent = "Locked to your first pick.";
      });
      if (decisionSession.rerolls > 1) {
        rejectButton.disabled = true;
        rejectButton.textContent = "First pick locked";
      }
      placeResult.append(rejectButton);
    }
    placeResult.classList.remove("hidden");
  }

  const savedDecision = sessionStorage.getItem("jom-decide-pick");
  if (savedDecision) {
    try {
      const restored = JSON.parse(savedDecision);
      if (Array.isArray(restored.places) && restored.first && restored.current
        && Number.isInteger(restored.rerolls) && restored.rerolls >= 0 && restored.rerolls <= 2) {
        decisionSession = restored;
        renderPlace(decisionSession.current);
        foodStatus.textContent = "Your current pick session is restored.";
      } else {
        throw new Error("Saved pick session has an invalid shape.");
      }
    } catch (error) {
      sessionStorage.removeItem("jom-decide-pick");
      foodStatus.textContent = error.message;
    }
  }

  let tournamentRound = [];
  let tournamentWinners = [];
  let tournamentMatchIndex = 0;
  let tournamentRoundNumber = 1;

  function renderTournamentMatch() {
    const target = document.querySelector("#tournament-match");
    target.replaceChildren();
    if (tournamentMatchIndex >= tournamentRound.length / 2) {
      if (tournamentWinners.length === 1) {
        const champion = document.createElement("article");
        champion.className = "rounded-2xl border border-lime/50 bg-panel p-5";
        const heading = document.createElement("p");
        heading.className = "mb-3 text-sm font-extrabold uppercase text-lime";
        heading.textContent = "🏆 Tournament champion";
        champion.append(heading);
        appendPlaceDetails(champion, tournamentWinners[0]);
        target.append(champion);
        document.querySelector("#tournament-status").textContent = "Champion chosen.";
        return;
      }
      tournamentRound = tournamentWinners;
      tournamentWinners = [];
      tournamentMatchIndex = 0;
      tournamentRoundNumber += 1;
    }

    const first = tournamentRound[tournamentMatchIndex * 2];
    const second = tournamentRound[tournamentMatchIndex * 2 + 1];
    document.querySelector("#tournament-status").textContent =
      `Round ${tournamentRoundNumber} · Match ${tournamentMatchIndex + 1} of ${tournamentRound.length / 2}`;
    [first, second].forEach((place) => {
      const card = document.createElement("article");
      card.className = "rounded-2xl border border-white/10 bg-panel p-4";
      appendPlaceDetails(card, place, true);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "mt-3 w-full rounded-xl bg-lime px-3 py-3 font-extrabold text-ink";
      button.textContent = "Pick this place";
      button.addEventListener("click", () => {
        tournamentWinners.push(place);
        tournamentMatchIndex += 1;
        renderTournamentMatch();
      });
      card.append(button);
      target.append(card);
    });
  }

  document.querySelector("#start-tournament").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    const status = document.querySelector("#tournament-status");
    const target = document.querySelector("#tournament-match");
    target.replaceChildren();
    status.textContent = "Finding tournament places…";
    try {
      const data = await requestJson("/api/places", {
        method: "POST",
        body: JSON.stringify(searchPayload("food"))
      });
      const size = Number(document.querySelector("#tournament-size").value);
      if (data.places.length < size) {
        throw new Error(`Only ${data.places.length} matching places found. Choose ${Math.min(4, data.places.length)} or widen filters.`);
      }
      tournamentRound = data.places.slice(0, size);
      for (let index = tournamentRound.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(Math.random() * (index + 1));
        [tournamentRound[index], tournamentRound[swap]] = [tournamentRound[swap], tournamentRound[index]];
      }
      tournamentWinners = [];
      tournamentMatchIndex = 0;
      tournamentRoundNumber = 1;
      renderTournamentMatch();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  let activeGroupId = null;
  let activeGroupShareUrl = null;
  let groupPollTimer = null;
  const savedVoterId = sessionStorage.getItem("jom-decide-voter-id");
  const voterId = telegram?.initDataUnsafe?.user?.id
    ? `telegram-${telegram.initDataUnsafe.user.id}`
    : savedVoterId || (() => {
      const value = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
      sessionStorage.setItem("jom-decide-voter-id", value);
      return value;
    })();

  function renderGroup(session) {
    const target = document.querySelector("#group-result");
    target.replaceChildren();
    session.places.forEach((place, index) => {
      const card = document.createElement("article");
      card.className = "rounded-2xl border border-white/10 bg-panel p-4";
      appendPlaceDetails(card, place, true);
      const count = session.votes[index] || 0;
      const vote = document.createElement("button");
      vote.className = "mt-3 w-full rounded-xl bg-lime px-3 py-3 font-extrabold text-ink";
      vote.type = "button";
      vote.textContent = `Vote · ${count} ${count === 1 ? "vote" : "votes"}`;
      vote.addEventListener("click", async () => {
        vote.disabled = true;
        try {
          const data = await requestJson(`/api/groups/${encodeURIComponent(activeGroupId)}/votes`, {
            method: "POST",
            body: JSON.stringify({ optionIndex: index, voterId })
          });
          renderGroup(data.session);
          document.querySelector("#group-status").textContent = "Vote saved. You can change your vote.";
        } catch (error) {
          document.querySelector("#group-status").textContent = error.message;
          vote.disabled = false;
        }
      });
      card.append(vote);

      const bar = document.createElement("div");
      bar.className = "mt-3 h-2 overflow-hidden rounded-full bg-white/10";
      const fill = document.createElement("div");
      fill.className = "h-full rounded-full bg-lime";
      fill.style.width = `${session.totalVotes ? Math.round(count / session.totalVotes * 100) : 0}%`;
      bar.append(fill);
      card.append(bar);
      target.append(card);
    });
    const maxVotes = Math.max(...session.votes);
    const leaders = session.places.filter((_place, index) => session.votes[index] === maxVotes);
    const summary = document.createElement("p");
    summary.className = "rounded-xl border border-lime/30 p-3 text-sm font-bold";
    summary.textContent = session.totalVotes
      ? `Current leader: ${leaders.map((place) => place.name).join(" / ")} · ${session.totalVotes} total votes`
      : "No votes yet.";
    target.prepend(summary);

    if (activeGroupShareUrl) {
      const share = document.createElement("button");
      share.className = "w-full rounded-xl border border-lime/50 px-4 py-3 font-extrabold text-lime";
      share.type = "button";
      share.textContent = "Share vote link";
      share.addEventListener("click", () => {
        const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(activeGroupShareUrl)}&text=${encodeURIComponent("Vote where we makan!")}`;
        if (telegram?.openTelegramLink) telegram.openTelegramLink(shareUrl);
        else window.open(shareUrl, "_blank", "noopener,noreferrer");
      });
      target.append(share);
    }
  }

  async function loadGroup(id, shareUrl = null) {
    activeGroupId = id;
    activeGroupShareUrl = shareUrl || `${window.location.origin}${window.location.pathname}?group=${encodeURIComponent(id)}`;
    document.querySelector("#group-status").textContent = "Loading group vote…";
    const data = await requestJson(`/api/groups/${encodeURIComponent(id)}`);
    renderGroup(data.session);
    document.querySelector("#group-status").textContent = "Vote once; change your vote any time.";
    if (groupPollTimer) window.clearInterval(groupPollTimer);
    groupPollTimer = window.setInterval(async () => {
      if (document.hidden || activeGroupId !== id) return;
      try {
        const update = await requestJson(`/api/groups/${encodeURIComponent(id)}`);
        renderGroup(update.session);
      } catch (error) {
        document.querySelector("#group-status").textContent = error.message;
        window.clearInterval(groupPollTimer);
      }
    }, 5000);
  }

  document.querySelector("#create-group").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    document.querySelector("#group-status").textContent = "Finding four options…";
    try {
      const data = await requestJson("/api/groups", {
        method: "POST",
        body: JSON.stringify(searchPayload("food"))
      });
      activeGroupShareUrl = data.shareUrl;
      await loadGroup(data.session.id, data.shareUrl);
      const shareUrl = new URL(data.shareUrl);
      history.replaceState(null, "", `${shareUrl.pathname}${shareUrl.search}`);
    } catch (error) {
      document.querySelector("#group-status").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  const sharedGroupId = new URLSearchParams(window.location.search).get("group");
  if (sharedGroupId) {
    document.querySelector("#tab-group").click();
    loadGroup(sharedGroupId).catch((error) => {
      document.querySelector("#group-status").textContent = error.message;
    });
  }

  document.querySelector("#generate-trip").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const location = document.querySelector("#trip-location").value.trim();
    const status = document.querySelector("#trip-generator-status");
    const result = document.querySelector("#generated-itinerary");
    result.replaceChildren();
    if (!location) {
      status.textContent = "Enter a Malaysian city or area.";
      return;
    }
    button.disabled = true;
    status.textContent = "Building your day…";
    try {
      const data = await requestJson("/api/trip", {
        method: "POST",
        body: JSON.stringify({ location })
      });
      data.stages.forEach((stage) => {
        const item = document.createElement("li");
        item.className = "rounded-xl border border-white/10 bg-ink p-3";
        const heading = document.createElement("p");
        heading.className = "font-bold text-lime";
        heading.textContent = `${stage.time} · ${stage.title}`;
        item.append(heading);
        appendPlaceDetails(item, stage.place, true);
        result.append(item);
      });
      status.textContent = `Your day in ${data.location}.`;
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  const coin = document.querySelector("#coin");
  document.querySelector("#flip-coin").addEventListener("click", (event) => {
    const sideA = document.querySelector("#coin-head").value.trim() || "Ya";
    const sideB = document.querySelector("#coin-tail").value.trim() || "Tidak";
    const button = event.currentTarget;
    button.disabled = true;
    coin.classList.remove("is-flipping");
    void coin.offsetWidth;
    coin.classList.add("is-flipping");
    coin.textContent = "…";

    window.setTimeout(() => {
      coin.textContent = randomItem([sideA, sideB]);
      coin.classList.remove("is-flipping");
      button.disabled = false;
      if (supportsHaptics) telegram.HapticFeedback.impactOccurred("light");
    }, 900);
  });

  const wheel = document.querySelector("#wheel");
  const wheelWrap = document.querySelector("#wheel-wrap");
  const wheelContext = wheel.getContext("2d");
  const wheelColors = ["#d7f36a", "#9d87ff", "#ff9d76", "#6ed9c1", "#ffcf5a", "#78b8ff", "#f288bf", "#b8dc8e", "#86d9ed", "#edaa73"];
  let wheelRotation = 0;
  let wheelBusy = false;

  function drawWheel(choices, rotation = 0) {
    const context = wheelContext;
    const center = wheel.width / 2;
    const radius = center - 5;
    const slice = (Math.PI * 2) / choices.length;
    context.clearRect(0, 0, wheel.width, wheel.height);
    choices.forEach((choice, index) => {
      const start = rotation + index * slice - Math.PI / 2;
      context.beginPath();
      context.moveTo(center, center);
      context.arc(center, center, radius, start, start + slice);
      context.closePath();
      context.fillStyle = wheelColors[index % wheelColors.length];
      context.fill();
      context.save();
      context.translate(center, center);
      context.rotate(start + slice / 2);
      context.textAlign = "right";
      context.fillStyle = "#10110f";
      context.font = "700 13px sans-serif";
      context.fillText(choice.slice(0, 18), radius - 14, 5, radius * 0.65);
      context.restore();
    });
    context.beginPath();
    context.arc(center, center, 8, 0, Math.PI * 2);
    context.fillStyle = "#10110f";
    context.fill();
  }

  document.querySelector("#spin-wheel").addEventListener("click", () => {
    if (wheelBusy) return;
    const choices = validateChoices(document.querySelector("#choices"), document.querySelector("#choice-status"));
    if (!choices) return;

    wheelBusy = true;
    const button = document.querySelector("#spin-wheel");
    const result = document.querySelector("#choice-result");
    button.disabled = true;
    result.textContent = "";
    wheelWrap.classList.remove("hidden");
    const startRotation = wheelRotation;
    const extraRotation = Math.PI * 2 * (5 + Math.random() * 3);
    const duration = 3200;
    const started = performance.now();

    function animate(now) {
      const progress = Math.min((now - started) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 4);
      wheelRotation = startRotation + extraRotation * eased;
      drawWheel(choices, wheelRotation);

      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        const slice = (Math.PI * 2) / choices.length;
        const pointerAngle = ((-wheelRotation % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        result.textContent = `Winner: ${choices[Math.floor(pointerAngle / slice)]}`;
        wheelBusy = false;
        button.disabled = false;
        if (supportsHaptics) telegram.HapticFeedback.notificationOccurred("success");
      }
    }

    drawWheel(choices, wheelRotation);
    requestAnimationFrame(animate);
  });

  document.querySelector("#build-itinerary").addEventListener("click", () => {
    const activitiesField = document.querySelector("#activities");
    const status = document.querySelector("#trip-status");
    const activities = validateChoices(activitiesField, status);
    const result = document.querySelector("#itinerary-result");
    result.replaceChildren();
    if (!activities) return;

    for (let index = activities.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [activities[index], activities[swapIndex]] = [activities[swapIndex], activities[index]];
    }

    const startMinutes = 9 * 60;
    const slotMinutes = Math.floor(480 / activities.length);
    activities.forEach((activity, index) => {
      const minutes = startMinutes + slotMinutes * index;
      const time = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
      const item = document.createElement("li");
      item.className = "flex gap-3 rounded-xl border border-white/10 bg-ink p-3";
      const timeLabel = document.createElement("span");
      timeLabel.className = "font-bold text-lime";
      timeLabel.textContent = time;
      const activityLabel = document.createElement("span");
      activityLabel.className = "text-sm";
      activityLabel.textContent = activity;
      item.append(timeLabel, activityLabel);
      result.append(item);
    });
    status.textContent = "";
  });
})();
