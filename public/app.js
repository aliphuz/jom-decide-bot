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
    foodStatus.textContent = "Finding nearby places…";
    const submitButton = foodForm.querySelector('[type="submit"]');
    submitButton.disabled = true;

    try {
      const response = await fetch(`${apiBase}/api/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location,
          coordinates: sharedCoordinates,
          type: document.querySelector("#place-type").value
        })
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Could not find a place.");
      }

      renderPlace(data.place);
      foodStatus.textContent = "Decision made. Enjoy!";
    } catch (error) {
      foodStatus.textContent = error.message || "Could not reach the server. Check your connection.";
    } finally {
      submitButton.disabled = false;
    }
  });

  function renderPlace(place) {
    placeResult.replaceChildren();

    const title = document.createElement("h3");
    title.className = "text-xl font-extrabold";
    title.textContent = place.name;
    placeResult.append(title);

    const category = document.createElement("p");
    category.className = "mt-2 text-sm font-bold text-lime";
    category.textContent = place.category;
    placeResult.append(category);

    const area = document.createElement("p");
    area.className = "mt-2 text-sm text-muted";
    area.textContent = place.area;
    placeResult.append(area);

    const navigation = document.createElement("div");
    navigation.className = "mt-5 flex flex-wrap gap-2";
    if (place.googleMapsUrl) {
      const link = document.createElement("a");
      link.className = "inline-flex rounded-xl bg-white px-4 py-3 text-sm font-extrabold text-ink";
      link.href = place.googleMapsUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Navigate with Google Maps";
      navigation.append(link);
    }
    if (place.wazeUrl) {
      const link = document.createElement("a");
      link.className = "inline-flex rounded-xl border border-white/15 px-4 py-3 text-sm font-extrabold";
      link.href = place.wazeUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Waze";
      navigation.append(link);
    }
    placeResult.append(navigation);

    placeResult.classList.remove("hidden");
  }

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

  document.querySelector("#pick-destination").addEventListener("click", () => {
    const choices = validateChoices(document.querySelector("#destinations"), document.querySelector("#trip-status"));
    document.querySelector("#destination-result").textContent = choices ? `Let’s go: ${randomItem(choices)}` : "";
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
