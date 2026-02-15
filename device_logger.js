// device_logger.js
// Architektur:
//
// 1) systemState_full.json            → kompletter Snapshot (Debug, 1:1)
// 2) hmip_device_catalog.json         → statische Geräteinfos (Capabilities)
// 3) status/devices/<id>.json         → aktueller Live-Status pro Gerät (inkl. Counter)
// 4) hmip_device_changes_last500.json → Event-Ringbuffer (letzte N)
//
// Ziele:
// - Beim Start: aus getSystemState ALLE Geräte initialisieren (Status-Dateien + Catalog + Snapshot)
// - Bei HMIP_SYSTEM_EVENT: nur betroffene Geräte-Datei überschreiben/mergen
// - Null-Werte nicht loggen (werden entfernt)
// - Keine doppelte Speicherung von functionalChannels (nicht mehr in device + state doppelt)

const fs = require("fs").promises;
const path = require("path");

function nowMs() {
  return Date.now();
}

async function readIfExists(p, fallback) {
  try {
    const s = await fs.readFile(p, "utf8");
    return JSON.parse(s);
  } catch (e) {
    if (e && e.code === "ENOENT") return fallback;
    throw e;
  }
}

// Windows-sicher: unique tmp + rename, bei EPERM/EACCES copy fallback
async function writeJsonAtomic(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });

  const tmp = `${p}.${process.pid}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}.tmp`;

  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");

  try {
    await fs.rename(tmp, p);
  } catch (e) {
    if (e && (e.code === "EPERM" || e.code === "EACCES")) {
      await fs.copyFile(tmp, p);
      await fs.unlink(tmp).catch(() => {});
    } else {
      await fs.unlink(tmp).catch(() => {});
      throw e;
    }
  }
}

// remove null/undefined recursively; keep false/0/""
function removeNullsDeep(obj) {
  if (obj === null || obj === undefined) return undefined;

  if (Array.isArray(obj)) {
    const arr = obj.map(removeNullsDeep).filter((v) => v !== undefined);
    return arr.length ? arr : undefined;
  }

  if (typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const cleaned = removeNullsDeep(v);
      if (cleaned !== undefined) out[k] = cleaned;
    }
    return Object.keys(out).length ? out : undefined;
  }

  return obj;
}

// Deep merge (objects merged recursively, arrays overwritten)
function deepMerge(target, src) {
  if (src === null || src === undefined) return target;
  if (typeof src !== "object") return src;

  if (Array.isArray(src)) return src.slice();

  if (!target || typeof target !== "object" || Array.isArray(target)) target = {};

  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      target[k] = deepMerge(target[k], v);
    } else if (Array.isArray(v)) {
      target[k] = v.slice();
    } else {
      target[k] = v;
    }
  }
  return target;
}

// devices container can be array or object-map; normalize to list
function devicesToList(devicesAny) {
  if (!devicesAny) return [];
  if (Array.isArray(devicesAny)) return devicesAny;
  if (typeof devicesAny === "object") return Object.values(devicesAny);
  return [];
}

// Update per-device change counters (keeps timestamps only for last 30 days)
function updateDeviceStats(existingDeviceState, eventTs) {
  const tNow = Date.now();
  const tEvent = typeof eventTs === "number" ? eventTs : tNow;

  const cutoff30d = tNow - 30 * 24 * 60 * 60 * 1000;
  const cutoff7d = tNow - 7 * 24 * 60 * 60 * 1000;
  const cutoff24h = tNow - 24 * 60 * 60 * 1000;

  const stats = existingDeviceState?.changeCounter || {
    sinceStartTotal: 0,
    changeTimestamps: [],
  };

  stats.sinceStartTotal += 1;

  stats.changeTimestamps = (stats.changeTimestamps || []).filter((t) => t >= cutoff30d);
  stats.changeTimestamps.push(tEvent);

  stats.last30d = stats.changeTimestamps.length;
  stats.last7d = stats.changeTimestamps.filter((t) => t >= cutoff7d).length;
  stats.last24h = stats.changeTimestamps.filter((t) => t >= cutoff24h).length;

  return stats;
}

function createHmipDeviceLogger(opts = {}) {
  const dir = opts.dir || process.cwd();
  const maxEntries = Number.isFinite(opts.maxEntries) ? opts.maxEntries : 500;

  const paths = {
    systemStateFull: path.join(dir, "systemState_full.json"),
    catalog: path.join(dir, "hmip_device_catalog.json"),
    changesLast500: path.join(dir, "hmip_device_changes_last500.json"),
    deviceDir: path.join(dir, "status", "devices"),
  };

  let last500 = [];
  let catalog = {};

  // serialize writes
  let writeQueue = Promise.resolve();
  function enqueueWrite(fn) {
    writeQueue = writeQueue.then(fn, fn);
    return writeQueue;
  }

  function extractDevicesFromSystemState(systemStateMessageBody) {
    const root = systemStateMessageBody?.body ?? systemStateMessageBody;
    const devicesAny = root?.devices ?? root?.body?.devices ?? root?.home?.devices;
    return devicesToList(devicesAny);
  }

  async function writeDeviceStatus(deviceId, data) {
    const p = path.join(paths.deviceDir, `${deviceId}.json`);
    await writeJsonAtomic(p, data);
  }

  async function readDeviceStatus(deviceId) {
    const p = path.join(paths.deviceDir, `${deviceId}.json`);
    return readIfExists(p, {});
  }

  return {
    paths,

    async init() {
      last500 = await readIfExists(paths.changesLast500, []);
      catalog = await readIfExists(paths.catalog, {});
      await fs.mkdir(paths.deviceDir, { recursive: true });
    },

    // Call on HMIP_SYSTEM_RESPONSE for getSystemState
    async handleSystemStateResponse(message) {
      const body = message?.body;
      if (!body) return;

      // 1) snapshot 1:1
      await enqueueWrite(async () => {
        await writeJsonAtomic(paths.systemStateFull, body);
      });

      // 2) initialize catalog + device states
      const devices = extractDevicesFromSystemState(body);
      const t = nowMs();

      for (const d of devices) {
        const id = d?.id;
        if (!id) continue;

        const cleaned = removeNullsDeep(d) || {};

        // ---- catalog (statisch) ----
        // (du kannst hier später noch mehr Felder ergänzen)
        catalog[id] = deepMerge(catalog[id], removeNullsDeep({
          id,
          modelType: d.modelType,
          type: d.type,
          manufacturerCode: d.manufacturerCode,
          oem: d.oem,
          modelId: d.modelId,
          firmwareVersion: d.firmwareVersion,
          firmwareVersionInteger: d.firmwareVersionInteger,
          permanentlyReachable: d.permanentlyReachable,
          connectionType: d.connectionType,
          availableFirmwareVersion: d.availableFirmwareVersion,
          updateState: d.updateState,
          supportedOptionalFeatures: d.supportedOptionalFeatures,
          // du könntest auch "functionalChannels" capabilities hier reinziehen,
          // aber wir lassen es erstmal bei device-level meta/capabilities
        }) || {});

        // ---- device live status (dynamisch / auswertbar) ----
        // Wichtig: keine doppelte Speicherung: functionalChannels nur hier.
        const deviceState = {
          id,
          updatedAt: t,
          // changeCounter initial (0 Änderungen seit Start)
          changeCounter: {
            sinceStartTotal: 0,
            last24h: 0,
            last7d: 0,
            last30d: 0,
            changeTimestamps: [],
          },
          // alles auswertbar: komplette functionalChannels (ohne nulls)
          functionalChannels: cleaned.functionalChannels || {},
        };

        await writeDeviceStatus(id, deviceState);
      }

      // 3) persist catalog
      await enqueueWrite(async () => {
        await writeJsonAtomic(paths.catalog, catalog);
      });
    },

    // Call on HMIP_SYSTEM_EVENT
    async handleHmipSystemEvent(message) {
      const tx = message?.body?.eventTransaction;
      const events = tx?.events;
      if (!events || typeof events !== "object") return;

      for (const ev of Object.values(events)) {
        if (ev?.pushEventType !== "DEVICE_CHANGED") continue;

        const d = ev?.device;
        if (!d?.id) continue;

        const id = d.id;
        const eventTs = tx?.timestamp ?? nowMs();
        const cleaned = removeNullsDeep(d) || {};

        // read existing per-device state
        const existing = await readDeviceStatus(id);

        // merge: overwrite only changed areas; keep rest
        const merged = deepMerge(existing, {
          id,
          updatedAt: eventTs,
          functionalChannels: cleaned.functionalChannels || {},
        });

        // update counters
        merged.changeCounter = updateDeviceStats(existing, eventTs);

        // write only this device
        await writeDeviceStatus(id, merged);

        // ring buffer (compact but useful)
        last500.push({
          ts: eventTs,
          deviceId: id,
        });

        if (last500.length > maxEntries) {
          last500.splice(0, last500.length - maxEntries);
        }
      }

      // persist ring buffer (queued)
      await enqueueWrite(async () => {
        await writeJsonAtomic(paths.changesLast500, last500);
      });
    },
  };
}

module.exports = { createHmipDeviceLogger };
