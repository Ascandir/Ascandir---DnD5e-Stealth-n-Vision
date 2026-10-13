/* Fenster: Sichtkegel einstellen, Spieler-Freigabe, Kampf nach Entdeckung */

import { MID, setting, num, clamp, normDeg, esc } from "./util.js";
import { rawConeConfig, storedFacing } from "./cones.js";

const { ApplicationV2 } = foundry.applications.api;

/** Himmelsrichtungen als Foundry-Rotation (0° = Blick nach unten) */
const DIRECTIONS = [
  ["N", 180, "fa-arrow-up"], ["NO", 225, "fa-arrow-up-right"], ["O", 270, "fa-arrow-right"], ["SO", 315, "fa-arrow-down-right"],
  ["S", 0, "fa-arrow-down"], ["SW", 45, "fa-arrow-down-left"], ["W", 90, "fa-arrow-left"], ["NW", 135, "fa-arrow-up-left"]
];

/* ------------------------------------------------------------------ */
/*  Sichtkegel eines Tokens                                            */
/* ------------------------------------------------------------------ */

export class ConeConfig extends ApplicationV2 {
  constructor(tokenDoc, options = {}) {
    super({ id: `${MID}-cone-${tokenDoc.id}`, ...options });
    this.doc = tokenDoc;
  }

  static DEFAULT_OPTIONS = {
    classes: ["ascandir-asv", "ascandir-asv-cone"],
    window: { title: "Sichtkegel", icon: "fa-solid fa-eye" },
    position: { width: 420, height: "auto" },
    actions: {
      save: ConeConfig._onSave,
      dir: ConeConfig._onDir,
      straighten: ConeConfig._onStraighten
    }
  };

  get title() { return `Sichtkegel: ${this.doc.name}`; }

  async _renderHTML() {
    const c = rawConeConfig(this.doc);
    const rot = Math.round(storedFacing(this.doc));
    const tokenTurned = Math.round(normDeg(num(this.doc.rotation))) !== 0;
    const units = canvas.scene?.grid?.units || "ft";
    const selected = (canvas.tokens?.controlled ?? []).filter((t) => t.document !== this.doc).length;
    const dirButtons = DIRECTIONS.map(([label, deg, icon]) =>
      `<button type="button" data-action="dir" data-deg="${deg}" title="${label}"><i class="fa-solid ${icon}"></i></button>`).join("");
    return `
      <form class="asv-form" autocomplete="off">
        <div class="form-group"><label>Sichtkegel aktiv</label><input type="checkbox" name="enabled" ${c.enabled ? "checked" : ""}></div>
        <div class="form-group"><label>Reichweite (${esc(units)})</label><input type="number" name="range" value="${c.range}" min="1" step="5"></div>
        <div class="form-group"><label>Öffnungswinkel (°)</label><input type="number" name="angle" value="${c.angle}" min="5" max="360" step="5"></div>
        <div class="form-group"><label>Blickrichtung (°)</label>
          <span class="asv-dir">
            <input type="range" name="rotation" value="${rot}" min="0" max="359" step="1">
            <output>${rot}°</output>
          </span>
        </div>
        <div class="asv-compass">${dirButtons}</div>
        <p class="asv-hint">Nur der Kegel dreht sich, der Token selbst bleibt, wie er ist.
        0° schaut nach unten (Süden), 180° nach oben (Norden).</p>
        ${tokenTurned ? `<p class="asv-hint warn">Der Token selbst ist gedreht (${Math.round(normDeg(num(this.doc.rotation)))}°).
          <button type="button" data-action="straighten"><i class="fa-solid fa-rotate-left"></i> Token gerade stellen</button></p>` : ""}

        <fieldset>
          <legend>Erkennung</legend>
          <label class="asv-check"><input type="radio" name="detect" value="enemies" ${c.detect !== "all" ? "checked" : ""}>
            Nur Gegner (entgegengesetzte Gesinnung, z. B. Spieler bei feindlichen Wachen)</label>
          <label class="asv-check"><input type="radio" name="detect" value="all" ${c.detect === "all" ? "checked" : ""}>
            Alle Gesinnungen</label>
          <label class="asv-check"><input type="checkbox" name="visible" ${c.visible ? "checked" : ""}>
            Auch Token erkennen, die nicht versteckt sind</label>
          <div class="form-group stacked">
            <label>Diese Namen ignorieren (mit ; trennen)</label>
            <input type="text" name="ignore" value="${esc(c.ignore)}" placeholder="z. B. Wirt; Barmaid; Stallbursche">
          </div>
        </fieldset>
        ${selected ? `<div class="form-group"><label>Auch für ${selected} weitere ausgewählte Token übernehmen</label><input type="checkbox" name="all"></div>` : ""}
        <footer class="asv-footer">
          <button type="button" data-action="save"><i class="fa-solid fa-floppy-disk"></i> Speichern</button>
        </footer>
      </form>`;
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
    const range = content.querySelector('input[name="rotation"]');
    const out = content.querySelector(".asv-dir output");
    range?.addEventListener("input", () => { out.textContent = `${range.value}°`; });
  }

  static _onDir(event, target) {
    const range = this.element.querySelector('input[name="rotation"]');
    range.value = target.dataset.deg;
    this.element.querySelector(".asv-dir output").textContent = `${range.value}°`;
  }

  static async _onStraighten(event, target) {
    await this.doc.update({ rotation: 0 });
    target.closest("p")?.remove();
  }

  static async _onSave() {
    const f = this.element.querySelector("form");
    const cone = {
      enabled: f.enabled.checked,
      range: Math.max(1, num(f.range.value, setting("defaultRange"))),
      angle: clamp(num(f.angle.value, setting("defaultAngle")), 5, 360),
      detect: f.querySelector('input[name="detect"]:checked')?.value === "all" ? "all" : "enemies",
      visible: f.visible.checked,
      ignore: f.ignore.value.split(";").map((n) => n.trim()).filter(Boolean).join("; ")
    };
    const facing = Math.round(normDeg(num(f.rotation.value)));
    const docs = [this.doc];
    if (f.all?.checked) docs.push(...canvas.tokens.controlled.map((t) => t.document).filter((d) => d !== this.doc));
    const updates = docs.map((d) => {
      const u = { _id: d.id, [`flags.${MID}.cone`]: cone };
      if (d === this.doc) u[`flags.${MID}.facing`] = facing;
      return u;
    });
    await canvas.scene.updateEmbeddedDocuments("Token", updates);
    this.close();
  }
}

/* ------------------------------------------------------------------ */
/*  Welche Spieler dürfen die Sichtkegel sehen?                        */
/* ------------------------------------------------------------------ */

export class ViewerConfig extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: `${MID}-viewers`,
    classes: ["ascandir-asv"],
    window: { title: "Sichtkegel für Spieler", icon: "fa-solid fa-users-viewfinder" },
    position: { width: 380, height: "auto" },
    actions: { save: ViewerConfig._onSave }
  };

  async _renderHTML() {
    const allowed = setting("coneViewers") ?? {};
    const players = game.users.filter((u) => !u.isGM);
    const rows = players.length
      ? players.map((u) => `
          <label class="asv-check">
            <input type="checkbox" name="u" value="${u.id}" ${allowed[u.id] ? "checked" : ""}>
            <span class="asv-swatch" style="background:${esc(u.color?.css ?? u.color ?? "#888")}"></span> ${esc(u.name)}
          </label>`).join("")
      : `<p class="asv-hint">Es gibt noch keine Spieler in dieser Welt.</p>`;
    return `
      <form class="asv-form">
        <p class="asv-hint">Der SL sieht die Sichtkegel immer. Hier gibst du sie einzelnen Spielern frei.</p>
        ${rows}
        <footer class="asv-footer"><button type="button" data-action="save"><i class="fa-solid fa-floppy-disk"></i> Speichern</button></footer>
      </form>`;
  }

  _replaceHTML(result, content) { content.innerHTML = result; }

  static async _onStraighten(event, target) {
    await this.doc.update({ rotation: 0 });
    target.closest("p")?.remove();
  }

  static async _onSave() {
    const map = {};
    for (const cb of this.element.querySelectorAll('input[name="u"]')) if (cb.checked) map[cb.value] = true;
    await game.settings.set(MID, "coneViewers", map);
    this.close();
  }
}

/* ------------------------------------------------------------------ */
/*  Entdeckt! Wer kommt in den Kampf?                                  */
/* ------------------------------------------------------------------ */

let combatPrompt = null;

export function openCombatPrompt(finds) {
  if (combatPrompt?.rendered) {
    combatPrompt.addFinds(finds);
    combatPrompt.render();
    combatPrompt.bringToFront?.();
    return combatPrompt;
  }
  combatPrompt = new CombatPrompt(finds);
  combatPrompt.render(true);
  return combatPrompt;
}

export class CombatPrompt extends ApplicationV2 {
  constructor(finds = [], options = {}) {
    super(options);
    this.watchers = new Set();
    this.found = new Set();
    this.checked = null;
    this.addFinds(finds);
  }

  static DEFAULT_OPTIONS = {
    id: `${MID}-combat`,
    classes: ["ascandir-asv", "ascandir-asv-combat"],
    window: { title: "Entdeckt! Kampf vorbereiten", icon: "fa-solid fa-triangle-exclamation", resizable: true },
    position: { width: 460, height: "auto" },
    actions: {
      start: CombatPrompt._onStart,
      cancel: CombatPrompt._onCancel,
      pan: CombatPrompt._onPan,
      all: CombatPrompt._onAll
    }
  };

  addFinds(finds) {
    for (const { watcher, hidden } of finds) {
      this.watchers.add(watcher.id);
      this.found.add(hidden.id);
      this.checked?.add(watcher.id);
      this.checked?.add(hidden.id);
    }
  }

  /** Kampf, zu dem hinzugefügt wird (noch nicht gestartet) */
  existingCombat() {
    return game.combats.find((c) => c.scene?.id === canvas.scene?.id && !c.started) ?? null;
  }

  candidates() {
    const combat = this.existingCombat();
    const already = new Set(combat?.combatants.map((c) => c.tokenId) ?? []);
    const toks = canvas.tokens.placeables.filter((t) => t.actor && !already.has(t.id));
    const anchor = canvas.tokens.get([...this.found][0]) ?? canvas.tokens.get([...this.watchers][0]);
    const dist = (t) => (anchor ? Math.hypot(t.x - anchor.x, t.y - anchor.y) : 0);
    const rank = (t) => (this.watchers.has(t.id) || this.found.has(t.id) ? 0 : t.actor.hasPlayerOwner ? 1 : 2);
    return toks.sort((a, b) => rank(a) - rank(b) || dist(a) - dist(b));
  }

  async _renderHTML() {
    const list = this.candidates();
    if (!this.checked) {
      this.checked = new Set(list.filter((t) =>
        this.watchers.has(t.id) || this.found.has(t.id) || (t.actor.hasPlayerOwner && t.actor.type === "character")).map((t) => t.id));
    }
    const rows = list.map((t) => {
      const tag = this.watchers.has(t.id) ? `<span class="asv-tag watch">Entdecker</span>`
        : this.found.has(t.id) ? `<span class="asv-tag found">Entdeckt</span>`
          : t.actor.hasPlayerOwner ? `<span class="asv-tag pc">Spieler</span>` : "";
      return `
        <label class="asv-row">
          <input type="checkbox" name="t" value="${t.id}" ${this.checked.has(t.id) ? "checked" : ""}>
          <img src="${esc(t.document.texture?.src)}" alt="">
          <a data-action="pan" data-id="${t.id}">${esc(t.document.name)}</a>
          ${t.document.hidden ? `<i class="fa-solid fa-eye-slash" title="Für Spieler versteckt"></i>` : ""}
          ${tag}
        </label>`;
    }).join("");
    const combat = this.existingCombat();
    return `
      <form class="asv-form">
        <p class="asv-hint">${game.paused ? "Das Spiel ist pausiert. " : ""}Wähle aus, wer dem Kampf beitritt${combat ? " (wird zum vorbereiteten Kampf hinzugefügt)" : ""}.</p>
        <div class="asv-tools">
          <button type="button" data-action="all" data-v="1">Alle</button>
          <button type="button" data-action="all" data-v="0">Keine</button>
        </div>
        <div class="asv-list">${rows || `<p class="asv-hint">Keine Token in dieser Szene.</p>`}</div>
        <div class="form-group"><label>Initiative der NSCs würfeln</label><input type="checkbox" name="rollNPC" checked></div>
        <div class="form-group"><label>Kampf sofort beginnen</label><input type="checkbox" name="begin"></div>
        <div class="form-group"><label>Pause danach aufheben</label><input type="checkbox" name="unpause"></div>
        <footer class="asv-footer">
          <button type="button" data-action="cancel"><i class="fa-solid fa-xmark"></i> Kein Kampf</button>
          <button type="button" data-action="start"><i class="fa-solid fa-swords"></i> Kampf erstellen</button>
        </footer>
      </form>`;
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
    content.querySelectorAll('input[name="t"]').forEach((cb) => cb.addEventListener("change", () => {
      if (cb.checked) this.checked.add(cb.value);
      else this.checked.delete(cb.value);
    }));
  }

  static _onAll(event, target) {
    const on = target.dataset.v === "1";
    this.element.querySelectorAll('input[name="t"]').forEach((cb) => {
      cb.checked = on;
      if (on) this.checked.add(cb.value);
      else this.checked.delete(cb.value);
    });
  }

  static _onPan(event, target) {
    event.preventDefault();
    const t = canvas.tokens.get(target.dataset.id);
    if (t) canvas.animatePan({ x: t.center.x, y: t.center.y });
  }

  static _onCancel() { this.close(); }

  static async _onStart() {
    const f = this.element.querySelector("form");
    const ids = [...this.element.querySelectorAll('input[name="t"]:checked')].map((cb) => cb.value);
    const tokens = ids.map((id) => canvas.tokens.get(id)).filter(Boolean);
    if (!tokens.length) {
      ui.notifications.warn("Niemand ausgewählt.");
      return;
    }
    const scene = canvas.scene;
    try {
      let combat = this.existingCombat();
      if (!combat) combat = await Combat.implementation.create({ scene: scene.id, active: true });
      else if (!combat.active) await combat.activate();
      const have = new Set(combat.combatants.map((c) => c.tokenId));
      const data = tokens.filter((t) => !have.has(t.id)).map((t) => ({
        tokenId: t.id, sceneId: scene.id, actorId: t.document.actorId, hidden: t.document.hidden
      }));
      if (data.length) await combat.createEmbeddedDocuments("Combatant", data);
      if (f.rollNPC.checked) await combat.rollNPC();
      if (f.begin.checked) await combat.startCombat();
      if (f.unpause.checked && game.paused) game.togglePause(false, { broadcast: true });
    } catch (err) {
      console.error(`${MID} | Kampf konnte nicht erstellt werden`, err);
      ui.notifications.error("Kampf konnte nicht erstellt werden (Details in der Konsole).");
      return;
    }
    this.close();
  }

  async close(options) {
    combatPrompt = null;
    return super.close(options);
  }
}
