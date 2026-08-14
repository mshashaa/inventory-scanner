const STORAGE_KEY = "inventory-scanner-items-v1";

const state = {
  items: loadItems(),
  scanner: null,
  scanning: false,
  lastScan: "",
  lastScanAt: 0,
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
};

render();
registerServiceWorker();

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
    });
  }

  saveItems();
  render();
  setStatus(`Added ${barcode}.`);
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
      saveItems();
      render();
    });

    plus.addEventListener("click", () => {
      item.count += 1;
      item.updatedAt = new Date().toISOString();
      saveItems();
      render();
    });

    minus.addEventListener("click", () => {
      item.count = Math.max(0, item.count - 1);
      item.updatedAt = new Date().toISOString();
      saveItems();
      render();
    });

    els.itemsList.append(row);
  });
}

async function startScanner() {
  if (state.scanning) return;

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

  if (state.lastScan === barcode && now - state.lastScanAt < 1400) {
    return;
  }

  state.lastScan = barcode;
  state.lastScanAt = now;
  addScan(barcode);
}

function setStatus(message) {
  els.scannerStatus.textContent = message;
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
  setStatus("Counts reset.");
}

function exportExcel() {
  const rows = [
    ["Barcode", "Product Name", "Count", "Last Updated"],
    ...state.items.map((item) => [item.barcode, item.name, item.count, item.updatedAt || ""]),
  ];

  const sheetRows = rows
    .map((row) => {
      const cells = row
        .map((value) => {
          const type = typeof value === "number" ? "Number" : "String";
          return `<Cell><Data ss:Type="${type}">${escapeXml(String(value))}</Data></Cell>`;
        })
        .join("");
      return `<Row>${cells}</Row>`;
    })
    .join("");

  const workbook = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Worksheet ss:Name="Inventory">
  <Table>${sheetRows}</Table>
 </Worksheet>
</Workbook>`;

  const blob = new Blob([workbook], { type: "application/vnd.ms-excel" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `inventory-${new Date().toISOString().slice(0, 10)}.xls`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function escapeXml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
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
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  });
}
