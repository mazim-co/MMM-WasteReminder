/* MagicMirror² — MMM-WasteReminder node helper */
const NodeHelper = require("node_helper");
const fs = require("fs/promises");
const path = require("path");
const ical = require("node-ical");
const { RRule } = require("rrule");
const { DateTime } = require("luxon");

module.exports = NodeHelper.create({
  start() { this.config = null; this.timer = null; },

  socketNotificationReceived(n, payload) {
    if (n === "CONFIG") {
      this.config = payload || {};
      this.fetchAll();
      if (this.timer) clearInterval(this.timer);
      this.timer = setInterval(() => this.fetchAll(), this.config.updateInterval || 3600000);
    }
  },

  async fetchAll() {
    try {
      const lists = await Promise.all([
        this.fromIcalUrls(this.config.icalUrls || []),
        this.fromIcalLocal(this.config.icalLocalPaths || []),
        this.fromManualItems(this.config.items || []),
        this.fromRules(this.config.rules || [])
      ]);

      const tz = this.config.timezone || "Europe/Berlin";
      const eventsByDay = new Map();

      const push = (isoDate, type) => {
        if (!isoDate || !type) return;
        const key = DateTime.fromISO(isoDate, { zone: tz }).toISODate();
        const entry = eventsByDay.get(key) || { date: key, types: [] };
        entry.types.push(type);
        eventsByDay.set(key, entry);
      };

      for (const list of lists) {
        for (const e of list) push(e.date, e.type);
      }

      const dedupSorted = Array.from(eventsByDay.values())
        .map(e => ({ date: DateTime.fromISO(e.date, { zone: tz }).toISODate(), types: Array.from(new Set(e.types)) }))
        .sort((a, b) => (a.date < b.date ? -1 : 1));

      const now = DateTime.now().setZone(tz).toISODate();
      const future = dedupSorted.filter(e => e.date >= now).slice(0, 200);

      this.sendSocketNotification("WASTE_EVENTS", future);
    } catch (err) {
      console.error("[MMM-WasteReminder] fetchAll error", err);
      this.sendSocketNotification("WASTE_EVENTS", []);
    }
  },

  // Remote ICS via URL
  async fromIcalUrls(urls) {
    const tz = this.config.timezone || "Europe/Berlin";
    const out = [];
    for (const url of urls) {
      if (!url || !/^https?:\/\//i.test(url)) continue;
      try {
        const data = await ical.async.fromURL(url, { timeout: 12000 });
        for (const k in data) {
          const ev = data[k];
          if (ev.type !== "VEVENT") continue;
          const dtLux = DateTime.fromJSDate(ev.start, { zone: tz }).startOf("day");
          const title = (ev.summary || "").trim();
          out.push({ date: dtLux.toISODate(), type: this.mapType(title) });
        }
      } catch (e) {
        console.error("[MMM-WasteReminder] ICS URL fetch failed", url, e?.message);
      }
    }
    return out;
  },

  // Local ICS files (downloaded)
  async fromIcalLocal(pathsArr) {
    const tz = this.config.timezone || "Europe/Berlin";
    const out = [];
    for (let p of pathsArr) {
      if (!p) continue;
      try {
        // allow relative to MagicMirror root
        if (!p.startsWith("/")) {
          // resolve relative to MagicMirror root
          const mmRoot = path.resolve(__dirname, "../../");
          p = path.join(mmRoot, p);
        }
        const buf = await fs.readFile(p, "utf8");
        const data = ical.sync.parseICS(buf);
        for (const k in data) {
          const ev = data[k];
          if (ev.type !== "VEVENT" || !ev.start) continue;
          const dtLux = DateTime.fromJSDate(ev.start, { zone: tz }).startOf("day");
          const title = (ev.summary || "").trim();
          out.push({ date: dtLux.toISODate(), type: this.mapType(title) });
        }
      } catch (e) {
        console.error("[MMM-WasteReminder] Local ICS read failed", p, e?.message);
      }
    }
    return out;
  },

  async fromManualItems(items) {
    const tz = this.config.timezone || "Europe/Berlin";
    const out = [];
    (items || []).forEach(it => {
      (it.dates || []).forEach(d => {
        const iso = DateTime.fromISO(d, { zone: tz }).toISODate();
        out.push({ date: iso, type: it.type });
      });
    });
    return out;
  },

  async fromRules(rules) {
    const tz = this.config.timezone || "Europe/Berlin";
    const now = DateTime.now().setZone(tz);
    const until = now.plus({ months: 6 });
    const out = [];

    for (const r of rules || []) {
      if (!r || !r.rrule) continue;
      const options = this.buildRRuleOptions(r.rrule, tz, now);
      const rule = new RRule(options);
      const dates = rule.between(now.toJSDate(), until.toJSDate(), true);
      dates.forEach(js => {
        const iso = DateTime.fromJSDate(js, { zone: tz }).startOf("day").toISODate();
        out.push({ date: iso, type: r.type });
      });
    }
    return out;
  },

  buildRRuleOptions(rr, tz, now) {
    const mapFreq = { DAILY: RRule.DAILY, WEEKLY: RRule.WEEKLY, MONTHLY: RRule.MONTHLY };
    const mapWday = { MO: RRule.MO, TU: RRule.TU, WE: RRule.WE, TH: RRule.TH, FR: RRule.FR, SA: RRule.SA, SU: RRule.SU };
    const opts = { dtstart: now.startOf("day").toJSDate(), freq: mapFreq[rr.freq || "MONTHLY"] };
    if (rr.byweekday) opts.byweekday = rr.byweekday.map(w => mapWday[w]);
    if (rr.bysetpos) opts.bysetpos = rr.bysetpos;
    if (rr.bymonthday) opts.bymonthday = rr.bymonthday;
    if (rr.bymonth) opts.bymonth = rr.bymonth;
    if (rr.interval) opts.interval = rr.interval;
    return opts;
  },

  mapType(title) {
  const s = (title || "")
    .toLowerCase()
    .normalize("NFD")                // normalize for ü/ö/ä
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .replace(/ü/g, "ue")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ß/g, "ss");

  const map = [
    { key: "hausmull", type: "Restmüll" },   // ✅ new mapping
    { key: "rest",      type: "Restmüll" },
    { key: "bio",       type: "Bio" },
    { key: "papier",    type: "Papier" },
    { key: "paper",     type: "Paper" },
    { key: "gelb",      type: "Gelber Sack" },
    { key: "plast",     type: "Plastic" },
    { key: "glas",      type: "Glass" }
  ];

  const hit = map.find(m => s.includes(m.key));
  return hit ? hit.type : title;
}
});