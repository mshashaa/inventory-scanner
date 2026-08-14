const STORAGE_KEY = "inventory-scanner-items-v1";
const SCAN_COOLDOWN_MS = 1000;
const PRODUCT_LOOKUP_URL = "https://upc.dev/v1/product/";
const SUPABASE_URL = "https://ujiujwuxucqokykzvseb.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVqaXVqd3V4dWNxb2t5a3p2c2ViIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY3MzAyNDIsImV4cCI6MjEwMjMwNjI0Mn0.tuzvWbm2iUMQ3UCUr2j1ISi35pBDZjGqnZWW4zAKsyg";
const INVENTORY_ENDPOINT = `${SUPABASE_URL}/rest/v1/inventory_items`;
const INCREMENT_ENDPOINT = `${SUPABASE_URL}/rest/v1/rpc/increment_inventory_item`;

const state = {
  items: loadItems(),
  scanner: null,
  scanning: false,
  audioContext: null,
  lastScan: "",
  lastScanAt: 0,
  lastAcceptedScanAt: 0,
  query: "",
};

const els = {
  startScan: document.querySelector("#startScan"),
  stopScan: document.querySelector("#stopScan"),
  scannerStatus: document.querySelector("#scannerStatus"),
  manualForm: document.querySelector("#manualForm"),
  barcodeInput: document.querySelector("#barcodeInput"),
  exportExcel: document.querySelector("#exportExcel"),
  resetCounts: document.querySelector("#resetCounts"),
  uniqueCount: document.querySelector("#uniqueCount"),
  totalCount: document.querySelector("#totalCount"),
  emptyState: document.querySelector("#emptyState"),
  itemsList: document.querySelector("#itemsList"),
  itemTemplate: document.querySelector("#itemTemplate"),
  searchInput: document.querySelector("#searchInput"),
  scanFlash: document.querySelector("#scanFlash"),
  scanToastDetail: document.querySelector("#scanToastDetail"),
};

render();
registerServiceWorker();
refreshSharedInventory();

els.startScan.addEventListener("click", startScanner);
els.stopScan.addEventListener("click", stopScanner);
els.exportExcel.addEventListener("click", exportExcel);
els.resetCounts.addEventListener("click", resetCounts);
els.searchInput.addEventListener("input", (event) => {
  state.query = event.target.value.trim().toLowerCase();
  render();
});

els.manualForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const barcode = normalizeBarcode(els.barcodeInput.value);
  if (!barcode) {
    setStatus("Enter a barcode first.");
    return;
  }

  addScan(barcode);
  confirmScan(barcode);
  els.barcodeInput.value = "";
  els.barcodeInput.focus();
});

function loadItems() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function saveItems() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.items));
}

function normalizeBarcode(value) {
  return String(value || "").trim();
}

function addScan(value) {
  const barcode = normalizeBarcode(value);
  if (!barcode) return;

  const existing = state.items.find((item) => item.barcode === barcode);
  if (existing) {
    existing.count += 1;
    existing.updatedAt = new Date().toISOString();
  } else {
    state.items.unshift({
      barcode,
      name: "",
      count: 1,
      updatedAt: new Date().toISOString(),
      lookupAttemptedAt: "",
      lookupStatus: "",
    });
  }

  saveItems();
  render();
  setStatus(`Added ${barcode}.`);
  syncScanToCloud(barcode).finally(() => lookupProductIfNeeded(barcode));
}

function render() {
  const filtered = state.items.filter((item) => {
    if (!state.query) return true;
    return item.barcode.toLowerCase().includes(state.query) || item.name.toLowerCase().includes(state.query);
  });

  els.uniqueCount.textContent = state.items.length;
  els.totalCount.textContent = state.items.reduce((total, item) => total + item.count, 0);
  els.emptyState.hidden = state.items.length > 0;
  els.itemsList.innerHTML = "";

  filtered.forEach((item) => {
    const row = els.itemTemplate.content.firstElementChild.cloneNode(true);
    const nameInput = row.querySelector(".item-name");
    const barcode = row.querySelector(".barcode");
    const updated = row.querySelector(".updated");
    const quantity = row.querySelector(".quantity");
    const plus = row.querySelector(".plus");
    const minus = row.querySelector(".minus");

    nameInput.value = item.name;
    barcode.textContent = item.barcode;
    updated.textContent = item.updatedAt ? `Updated ${new Date(item.updatedAt).toLocaleString()}` : "";
    quantity.textContent = item.count;

    nameInput.addEventListener("change", () => {
      item.name = nameInput.value.trim();
      item.updatedAt = new Date().toISOString();
      if (item.name) {
        item.lookupStatus = "manual";
        item.lookupAttemptedAt = item.lookupAttemptedAt || new Date().toISOString();
      }
      saveItems();
      render();
      syncProductNameToCloud(item);
    });

    plus.addEventListener("click", () => {
      item.count += 1;
      item.updatedAt = new Date().toISOString();
      saveItems();
      render();
      syncCountToCloud(item);
    });

    minus.addEventListener("click", () => {
      item.count = Math.max(0, item.count - 1);
      item.updatedAt = new Date().toISOString();
      saveItems();
      render();
      syncCountToCloud(item);
    });

    els.itemsList.append(row);
  });
}

async function startScanner() {
  if (state.scanning) return;

  primeAudio();
  setStatus("Starting camera...");
  els.startScan.disabled = true;

  try {
    await loadScannerLibrary();
    state.scanner = new Html5Qrcode("reader", { verbose: false });
    await state.scanner.start(
      { facingMode: "environment" },
      {
        fps: 10,
        qrbox: (viewfinderWidth, viewfinderHeight) => {
          const size = Math.floor(Math.min(viewfinderWidth, viewfinderHeight) * 0.72);
          return { width: size, height: size };
        },
      },
      onScanSuccess,
      () => {}
    );
    state.scanning = true;
    els.stopScan.disabled = false;
    setStatus("Camera is ready. Point it at a barcode.");
  } catch (error) {
    els.startScan.disabled = false;
    setStatus("Camera scanner could not start. You can still type barcodes manually.");
    console.error(error);
  }
}

async function stopScanner() {
  if (!state.scanner) return;
  try {
    await state.scanner.stop();
    await state.scanner.clear();
  } catch (error) {
    console.error(error);
  }
  state.scanner = null;
  state.scanning = false;
  els.startScan.disabled = false;
  els.stopScan.disabled = true;
  setStatus("Camera stopped.");
}

function onScanSuccess(decodedText) {
  const barcode = normalizeBarcode(decodedText);
  const now = Date.now();
  if (!barcode) return;

  if (now - state.lastAcceptedScanAt < SCAN_COOLDOWN_MS) {
    return;
  }

  state.lastScan = barcode;
  state.lastScanAt = now;
  state.lastAcceptedScanAt = now;
  addScan(barcode);
  confirmScan(barcode);
}

function setStatus(message) {
  els.scannerStatus.textContent = message;
}

function cloudHeaders(prefer) {
  const headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (prefer) {
    headers.Prefer = prefer;
  }

  return headers;
}

function toAppItem(row) {
  return {
    barcode: row.barcode,
    name: row.product_name || "",
    count: Number(row.count || 0),
    updatedAt: row.updated_at || "",
    lookupAttemptedAt: row.lookup_attempted_at || "",
    lookupStatus: row.lookup_status || "",
  };
}

function toCloudPatch(item) {
  return {
    product_name: item.name || "",
    count: item.count,
    lookup_attempted_at: item.lookupAttemptedAt || null,
    lookup_status: item.lookupStatus || "",
    updated_at: item.updatedAt || new Date().toISOString(),
  };
}

function replaceLocalItem(nextItem) {
  const index = state.items.findIndex((item) => item.barcode === nextItem.barcode);
  if (index >= 0) {
    state.items[index] = nextItem;
  } else {
    state.items.unshift(nextItem);
  }
  saveItems();
  render();
}

async function refreshSharedInventory() {
  try {
    const response = await fetch(`${INVENTORY_ENDPOINT}?select=*&order=updated_at.desc`, {
      headers: cloudHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Supabase inventory fetch failed: ${response.status}`);
    }

    const rows = await response.json();
    state.items = rows.map(toAppItem);
    saveItems();
    render();
    setStatus("Shared inventory synced.");
  } catch (error) {
    setStatus("Using local cache. Shared inventory sync failed.");
    console.error(error);
  }
}

async function syncScanToCloud(barcode) {
  try {
    const response = await fetch(INCREMENT_ENDPOINT, {
      method: "POST",
      headers: cloudHeaders(),
      body: JSON.stringify({ upc: barcode }),
    });

    if (!response.ok) {
      throw new Error(`Supabase increment failed: ${response.status}`);
    }

    const result = await response.json();
    const row = Array.isArray(result) ? result[0] : result;
    if (row && row.barcode) {
      replaceLocalItem(toAppItem(row));
    }
    setStatus(`Shared count updated for ${barcode}.`);
  } catch (error) {
    setStatus("Scan saved locally. Shared count update failed.");
    console.error(error);
  }
}

async function syncProductNameToCloud(item) {
  try {
    const response = await fetch(`${INVENTORY_ENDPOINT}?barcode=eq.${encodeURIComponent(item.barcode)}`, {
      method: "PATCH",
      headers: cloudHeaders("return=representation"),
      body: JSON.stringify({
        product_name: item.name || "",
        lookup_attempted_at: item.lookupAttemptedAt || null,
        lookup_status: item.lookupStatus || "manual",
        updated_at: new Date().toISOString(),
      }),
    });

    if (!response.ok) {
      throw new Error(`Supabase name update failed: ${response.status}`);
    }

    const rows = await response.json();
    if (rows[0]) {
      replaceLocalItem(toAppItem(rows[0]));
    }
    setStatus(`Shared product name updated for ${item.barcode}.`);
  } catch (error) {
    setStatus("Name saved locally. Shared name update failed.");
    console.error(error);
  }
}

async function syncCountToCloud(item) {
  try {
    const response = await fetch(`${INVENTORY_ENDPOINT}?barcode=eq.${encodeURIComponent(item.barcode)}`, {
      method: "PATCH",
      headers: cloudHeaders("return=representation"),
      body: JSON.stringify(toCloudPatch(item)),
    });

    if (!response.ok) {
      throw new Error(`Supabase count update failed: ${response.status}`);
    }

    const rows = await response.json();
    if (rows[0]) {
      replaceLocalItem(toAppItem(rows[0]));
    }
    setStatus(`Shared count updated for ${item.barcode}.`);
  } catch (error) {
    setStatus("Count changed locally. Shared count update failed.");
    console.error(error);
  }
}

async function lookupProductIfNeeded(barcode) {
  const item = state.items.find((entry) => entry.barcode === barcode);
  if (!item || item.name || item.lookupAttemptedAt) return;

  item.lookupAttemptedAt = new Date().toISOString();
  item.lookupStatus = "looking";
  saveItems();
  setStatus(`Looking up ${barcode}...`);

  try {
    const response = await fetch(`${PRODUCT_LOOKUP_URL}${encodeURIComponent(barcode)}`, {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      item.lookupStatus = response.status === 404 ? "not-found" : "failed";
      saveItems();
      syncLookupToCloud(item);
      setStatus(response.status === 404 ? `No product name found for ${barcode}.` : "Product lookup failed.");
      return;
    }

    const result = await response.json();
    const product = result.data || result.product || {};
    const productName = [product.brand, product.name || product.product_name]
      .filter(Boolean)
      .join(" ")
      .trim();

    if (productName) {
      item.name = productName;
      item.lookupStatus = "found";
      item.updatedAt = new Date().toISOString();
      saveItems();
      render();
      syncProductNameToCloud(item);
      setStatus(`Found product name for ${barcode}.`);
      return;
    }

    item.lookupStatus = "not-found";
    saveItems();
    syncLookupToCloud(item);
    setStatus(`No product name found for ${barcode}.`);
  } catch (error) {
    item.lookupStatus = "failed";
    saveItems();
    syncLookupToCloud(item);
    setStatus("Product lookup failed. You can still name the item manually.");
    console.error(error);
  }
}

async function syncLookupToCloud(item) {
  try {
    const response = await fetch(`${INVENTORY_ENDPOINT}?barcode=eq.${encodeURIComponent(item.barcode)}`, {
      method: "PATCH",
      headers: cloudHeaders("return=representation"),
      body: JSON.stringify({
        product_name: item.name || "",
        lookup_attempted_at: item.lookupAttemptedAt || null,
        lookup_status: item.lookupStatus || "",
        updated_at: item.updatedAt || new Date().toISOString(),
      }),
    });

    if (!response.ok) {
      throw new Error(`Supabase lookup update failed: ${response.status}`);
    }

    const rows = await response.json();
    if (rows[0]) {
      replaceLocalItem(toAppItem(rows[0]));
    }
  } catch (error) {
    console.error(error);
  }
}

function resetCounts() {
  if (!state.items.length) return;
  const confirmed = window.confirm("Reset all quantities to 0? Product names and barcodes will stay in the list.");
  if (!confirmed) return;

  const now = new Date().toISOString();
  state.items.forEach((item) => {
    item.count = 0;
    item.updatedAt = now;
  });
  saveItems();
  render();
  resetSharedCounts();
  setStatus("Counts reset.");
}

async function resetSharedCounts() {
  try {
    const response = await fetch(`${INVENTORY_ENDPOINT}?barcode=not.is.null`, {
      method: "PATCH",
      headers: cloudHeaders("return=representation"),
      body: JSON.stringify({
        count: 0,
        updated_at: new Date().toISOString(),
      }),
    });

    if (!response.ok) {
      throw new Error(`Supabase reset failed: ${response.status}`);
    }

    const rows = await response.json();
    state.items = rows.map(toAppItem);
    saveItems();
    render();
    setStatus("Shared counts reset.");
  } catch (error) {
    setStatus("Counts reset locally. Shared reset failed.");
    console.error(error);
  }
}

function exportExcel() {
  const rows = [
    ["Barcode", "Product Name", "Count", "Last Updated"],
    ...state.items.map((item) => [item.barcode, item.name, item.count, item.updatedAt || ""]),
  ];

  const csv = rows.map((row) => row.map(escapeCsv).join(",")).join("\r\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `inventory-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function escapeCsv(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function confirmScan(barcode) {
  showScanToast(barcode);
  playScanTone();

  if ("vibrate" in navigator) {
    navigator.vibrate(35);
  }
}

function showScanToast(barcode) {
  els.scanToastDetail.textContent = barcode;
  els.scanFlash.hidden = false;
  els.scanFlash.classList.remove("is-visible");
  void els.scanFlash.offsetWidth;
  els.scanFlash.classList.add("is-visible");
  window.clearTimeout(showScanToast.hideTimer);
  showScanToast.hideTimer = window.setTimeout(() => {
    els.scanFlash.hidden = true;
  }, 820);
}

function primeAudio() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;

  if (!state.audioContext) {
    state.audioContext = new AudioContext();
  }

  if (state.audioContext.state === "suspended") {
    state.audioContext.resume().catch(() => {});
  }
}

function playScanTone() {
  primeAudio();
  const context = state.audioContext;
  if (!context || context.state === "suspended") return;

  const now = context.currentTime;
  const oscillator = context.createOscillator();
  const secondOscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = "square";
  secondOscillator.type = "sine";
  oscillator.frequency.setValueAtTime(1046, now);
  oscillator.frequency.exponentialRampToValueAtTime(1568, now + 0.09);
  secondOscillator.frequency.setValueAtTime(2093, now + 0.04);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.32, now + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);

  oscillator.connect(gain);
  secondOscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(now);
  secondOscillator.start(now + 0.045);
  oscillator.stop(now + 0.23);
  secondOscillator.stop(now + 0.2);
}

function loadScannerLibrary() {
  if (window.Html5Qrcode) return Promise.resolve();

  return loadScript("https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js");
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = resolve;
    script.onerror = reject;
    document.head.append(script);
  });
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js?v=6").catch(() => {});
  });
}
