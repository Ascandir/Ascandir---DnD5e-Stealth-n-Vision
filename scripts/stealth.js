/*
 * Heimlichkeit: Wurf merken, im HUD anzeigen, Vorteil beim Angriff aus dem Versteck,
 * Status "Versteckt+" (vom SL).
 */

import { MID, HIDING, HIDING_PLUS, setting, isLeader, num, hasStatus, passivePerception, esc } from "./util.js";

/* ------------------------------------------------------------------ */
/*  Gespeicherter Heimlichkeitswert                                    */
/* ------------------------------------------------------------------ */

/** {value, time} oder null */
export function getStealth(actor) {
  const f = actor?.getFlag?.(MID, "stealth");
  return f && Number.isFinite(Number(f.value)) ? { value: Number(f.value), time: num(f.time) } : null;
}

/** Wert, der angezeigt/benutzt wird – nur solange der Actor versteckt ist */
export function activeStealth(actor) {
  if (!hasStatus(actor, HIDING)) return null;
  return getStealth(actor)?.value ?? null;
}

export async function setStealth(actor, value) {
  if (!actor) return;
  if (value === null || value === undefined || value === "") {
    if (actor.getFlag(MID, "stealth") !== undefined) await actor.unsetFlag(MID, "stealth");
    return;
  }
  await actor.setFlag(MID, "stealth", { value: Number(value), time: Date.now() });
}

/** Versteckt+ an/aus. Beim Einschalten wird "Versteckt" mit gesetzt. */
export async function toggleHidingPlus(actor, active) {
  if (!actor) return;
  active ??= !hasStatus(actor, HIDING_PLUS);
  if (active && !hasStatus(actor, HIDING)) await actor.toggleStatusEffect(HIDING, { active: true });
  await actor.toggleStatusEffect(HIDING_PLUS, { active });
}

function rerenderHud(actor) {
  const hud = canvas?.tokens?.hud;
  if (hud?.rendered && hud.object?.actor === actor) hud.render();
}

/* ------------------------------------------------------------------ */
/*  Hooks                                                              */
/* ------------------------------------------------------------------ */

export function registerStealthHooks({ onHidingChanged }) {
  // Heimlichkeit gewürfelt → Wert am Actor merken (läuft beim Würfelnden)
  Hooks.on("dnd5e.rollSkillV2", (rolls, data) => {
    if (data?.skill !== "ste") return;
    const actor = data.subject;
    const total = rolls?.[0]?.total;
    if (!actor?.isOwner || !Number.isFinite(total)) return;
    setStealth(actor, total);
  });

  // Angriff aus dem Versteck: Vorteil, wenn die Heimlichkeit über der passiven Wahrnehmung aller Ziele liegt
  Hooks.on("dnd5e.preRollAttackV2", (config, dialog, message) => {
    if (!setting("attackAdvantage")) return;
    const actor = config?.subject?.actor;
    const stealth = activeStealth(actor);
    if (stealth === null) return;
    const targets = [...(game.user.targets ?? [])].filter((t) => t.actor && t.actor !== actor);
    if (!targets.length) return;
    const pps = targets.map((t) => passivePerception(t.actor));
    if (pps.some((pp) => pp === null || stealth <= pp)) return;

    config.advantage = true;
    for (const r of config.rolls ?? []) {
      r.options ??= {};
      r.options.advantage = true;
    }
    const note = targets.length === 1
      ? `aus dem Versteck: Heimlichkeit ${stealth} gegen passive Wahrnehmung ${pps[0]}`
      : `aus dem Versteck: Heimlichkeit ${stealth} gegen passive Wahrnehmung ${pps.join(", ")}`;
    if (message?.data) message.data.flavor = `${message.data.flavor ?? ""} <span class="asv-flavor">(${esc(note)})</span>`;
  });

  // Nach dem Angriff ggf. aus dem Versteck kommen
  Hooks.on("dnd5e.rollAttackV2", (rolls, data) => {
    if (!setting("revealOnAttack")) return;
    const actor = data?.subject?.actor;
    if (actor?.isOwner && hasStatus(actor, HIDING)) actor.toggleStatusEffect(HIDING, { active: false });
  });

  // Versteckt an/aus → Wert aufräumen (nur beim aktiven SL, damit es nicht doppelt passiert)
  const onEffect = (effect, added) => {
    const actor = effect?.parent;
    if (actor?.documentName !== "Actor") return;
    const statuses = effect.statuses;
    const touches = (id) => statuses?.has?.(id) || statuses?.includes?.(id);
    if (!touches(HIDING) && !touches(HIDING_PLUS)) return;
    // Statuswerte am Actor sind erst nach dem Neuaufbau aktuell
    setTimeout(async () => {
      if (isLeader() && touches(HIDING)) {
        if (added) {
          // Ein alter Wurf zählt nicht mehr
          const f = getStealth(actor);
          const windowMin = num(setting("stealthWindow"), 5);
          if (f && windowMin > 0 && Date.now() - f.time > windowMin * 60000) await setStealth(actor, null);
        } else if (!hasStatus(actor, HIDING)) {
          await setStealth(actor, null);
          if (hasStatus(actor, HIDING_PLUS)) await actor.toggleStatusEffect(HIDING_PLUS, { active: false });
        }
      }
      rerenderHud(actor);
      onHidingChanged?.(actor);
    }, 50);
  };
  Hooks.on("createActiveEffect", (e) => onEffect(e, true));
  Hooks.on("deleteActiveEffect", (e) => onEffect(e, false));
  Hooks.on("updateActiveEffect", (e, changes) => {
    if ("disabled" in (changes ?? {})) onEffect(e, !e.disabled);
  });

  Hooks.on("updateActor", (actor, changes) => {
    if (foundry.utils.hasProperty(changes, `flags.${MID}`) || changes?.flags?.[`-=${MID}`] !== undefined) rerenderHud(actor);
  });
}

/* ------------------------------------------------------------------ */
/*  Token-HUD (Rechtsklick auf einen Token, nur SL)                    */
/* ------------------------------------------------------------------ */

export function stealthHudElement(actor) {
  const value = activeStealth(actor);
  const pp = passivePerception(actor);
  const hiding = hasStatus(actor, HIDING);
  const el = document.createElement("div");
  el.className = `control-icon asv-stealth ${hiding ? "active" : ""}`;
  el.dataset.tooltip = hiding
    ? "Heimlichkeit (gewürfelt). Wert eintragen oder ändern, Enter zum Speichern."
    : "Nicht versteckt. Einen Wert eintragen versteckt die Figur.";
  el.innerHTML = `
    <i class="fa-solid fa-user-ninja"></i>
    <input type="text" inputmode="numeric" value="${value ?? ""}" placeholder="–" aria-label="Heimlichkeit">
    ${pp !== null ? `<span class="asv-pp" data-tooltip="Passive Wahrnehmung">WN ${pp}</span>` : ""}`;
  const input = el.querySelector("input");
  for (const ev of ["keydown", "keyup", "mousedown", "click", "dblclick", "contextmenu"]) {
    input.addEventListener(ev, (e) => {
      e.stopPropagation();
      if (ev === "keydown" && e.key === "Enter") input.blur();
    });
  }
  input.addEventListener("change", async () => {
    const raw = input.value.trim();
    if (raw === "") {
      await setStealth(actor, null);
      return;
    }
    const v = Number(raw);
    if (!Number.isFinite(v)) {
      input.value = value ?? "";
      return;
    }
    await setStealth(actor, Math.round(v));
    if (!hasStatus(actor, HIDING)) await actor.toggleStatusEffect(HIDING, { active: true });
  });
  return el;
}
