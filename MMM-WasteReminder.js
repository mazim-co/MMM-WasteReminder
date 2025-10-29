/* global Module, Log */
/* MagicMirror² Module: MMM-WasteReminder */

// REMOVE any "require('luxon')" lines.
// Use the global provided by vendor/luxon.min.js instead:
let DateTime, Interval;

Module.register("MMM-WasteReminder", {
  // Load Luxon (browser build) before our code runs
  getScripts() {
    return [this.file("vendor/luxon.min.js")];
  },

  getStyles() { return ["MMM-WasteReminder.css"]; },

  defaults: {
    header: "Abfallkalender",
    locale: "de-DE",
    timezone: "Europe/Berlin",

    icalUrls: [],
    icalLocalPaths: [],
    items: [],
    rules: [],

    showCount: 5,
    groupSameDay: true,

    remindAtHour: 20,
    leadHoursBefore: 12,
    notify: true,
    notificationId: "WASTE_REMINDER",

    typeMap: {
      "Restmüll":   { label: "Restmüll", icon: null },
      "Bio":        { label: "Bio", icon: null },
      "Papier":     { label: "Papier", icon: null },
      "Gelber Sack":{ label: "Gelber Sack", icon: null },
      "Paper":      { label: "Paper", icon: null },
      "Plastic":    { label: "Plastic", icon: null },
      "Glass":      { label: "Glass", icon: null }
    },

    debug: false,
    updateInterval: 60 * 60 * 1000
  },

  start() {
    // Bind Luxon globals AFTER scripts load
    DateTime = window.luxon.DateTime;
    Interval = window.luxon.Interval;

    this.events = [];
    this.ready = false;
    if (this.config.debug) Log.log("[WASTE] start()");
    this.sendSocketNotification("CONFIG", this.config);
    this.updateDom();
    setInterval(() => this.updateDom(), 5 * 60 * 1000);
  },

getHeader() {
  // prefer the module's top-level header, then optional fallback in config, else default
  return this.data.header || this.config.header || "Abfallkalender";
},

  socketNotificationReceived(n, payload) {
    if (n === "WASTE_EVENTS") {
      this.events = payload || [];
      this.ready = true;
      this.updateDom();
    }
  },

  getNextPickups() {
    const tz = this.config.timezone;
    const now = DateTime.now().setZone(tz);

    const future = (this.events || [])
      .map(e => ({ date: DateTime.fromISO(e.date, { zone: tz }).startOf("day"), types: e.types }))
      .filter(e => e.date >= now.startOf("day"))
      .sort((a, b) => a.date - b.date);

    let merged = [];
    if (this.config.groupSameDay) {
      for (const e of future) {
        const last = merged[merged.length - 1];
        if (last && last.date.hasSame(e.date, "day")) {
          last.types = Array.from(new Set([...last.types, ...e.types]));
        } else {
          merged.push({ date: e.date, types: [...e.types] });
        }
      }
    } else {
      merged = future;
    }

    return merged.slice(0, this.config.showCount);
  },

  computeBadge(dt) {
    const tz = this.config.timezone;
    const now = DateTime.now().setZone(tz);

    const when = dt.set({ hour: this.config.remindAtHour, minute: 0, second: 0 });
    const hoursUntil = when.diff(now, "hours").hours;

    if (hoursUntil <= this.config.leadHoursBefore && hoursUntil >= -12) {
      const isToday = dt.hasSame(now, "day");
      return { cls: "due " + (isToday ? "today" : "tomorrow"), text: isToday ? "heute" : "morgen" };
    }
    const days = Math.round(Interval.fromDateTimes(now.startOf("day"), dt).length("days"));
    if (days === 0) return { cls: "today", text: "heute" };
    if (days === 1) return { cls: "tomorrow", text: "morgen" };
    return { cls: "", text: `${days}d` };
  },

  notifyIfDue(nextItems) {
    if (!this.config.notify || !nextItems?.length) return;
    const tz = this.config.timezone;
    const now = DateTime.now().setZone(tz);

    for (const item of nextItems) {
      const when = item.date.set({ hour: this.config.remindAtHour });
      const hoursUntil = when.diff(now, "hours").hours;
      if (hoursUntil <= this.config.leadHoursBefore && hoursUntil > -3) {
        const list = item.types.join(", ");
        this.sendNotification("SHOW_ALERT", {
          title: "Mülltonnen rausstellen",
          message: `${list} – ${when.toLocaleString(DateTime.TIME_24_SIMPLE)}`,
          timer: 8000
        });
        break;
      }
    }
  },

  getDom() {
    const wrapper = document.createElement("div");
    wrapper.className = "wrapper";

    if (!this.ready) {
      wrapper.innerHTML = "<span class='dimmed'>Loading waste schedule…</span>";
      return wrapper;
    }

    const list = this.getNextPickups();
    this.notifyIfDue(list);

    const container = document.createElement("div");
    container.className = "list";

    if (list.length === 0) {
      container.innerHTML = "<span class='dimmed'>No upcoming pickups.</span>";
      wrapper.appendChild(container);
      return wrapper;
    }

    for (const item of list) {
      const row = document.createElement("div");
      row.className = "row";
      row.dataset.type = item.types[0];

      const typeCell = document.createElement("div");
      typeCell.className = "type";

      item.types.forEach((t, i) => {
        const map = this.config.typeMap[t] || { label: t, icon: null };
        const span = document.createElement("span");
        span.className = "type-bit";
        if (map.icon) {
          const img = document.createElement("img");
          img.className = "icon";
          img.src = this.file(`icons/${map.icon}`);
          span.appendChild(img);
        }
        span.appendChild(document.createTextNode(map.label || t));
        if (i < item.types.length - 1) span.appendChild(document.createTextNode(", "));
        typeCell.appendChild(span);
      });

      const whenCell = document.createElement("div");
      whenCell.className = "when";
      whenCell.innerText = item.date.setLocale(this.config.locale).toFormat("ccc dd.MM.");

      const etaCell = document.createElement("div");
      etaCell.className = "eta";
      const badge = this.computeBadge(item.date);
      const b = document.createElement("span");
      b.className = `badge ${badge.cls}`.trim();
      b.innerText = badge.text;
      etaCell.appendChild(b);

      row.appendChild(typeCell);
      row.appendChild(whenCell);
      row.appendChild(etaCell);
      container.appendChild(row);
    }

    wrapper.appendChild(container);
    return wrapper;
  }
});